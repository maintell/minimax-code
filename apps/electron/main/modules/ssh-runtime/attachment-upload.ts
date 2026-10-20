import { sshExecution } from "./ssh-execution.js";
import { randomUUID, createHash } from "node:crypto";
import { stat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { sshProjectIdFromRuntimeId, isDesktopRuntimeId } from "@mavis/shared/desktop-runtime";
import { resolveSshRuntimeTarget, isSafeAbsoluteRemotePath } from "./config";
import { classifySshFailure } from "./errors";
import { buildSshAttachmentUploadSpawnSpec, parseSshAttachmentUploadPath } from "./ssh-command";
export let MAX_SSH_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_BASE64_ATTACHMENT_CHARS = Math.ceil((MAX_SSH_ATTACHMENT_BYTES * 4) / 3) + 4;
const UPLOAD_TIMEOUT_MS = 120000;
/** Main-owned selected-file transfer. No workspace directory is synchronized. */
export class SshAttachmentUploader {
    constructor(repository, connections, runCommand, createUploadId = randomUUID) {
        this.repository = repository;
        this.connections = connections;
        this.runCommand = runCommand;
        this.createUploadId = createUploadId;
    }
    async upload(value) {
        const input = parseUploadInput(value);
        if (!input)
            return { success: false, error: 'invalid_input' };
        const projectId = sshProjectIdFromRuntimeId(input.runtimeId);
        const projectTarget = projectId ? this.repository.getRuntimeTarget(projectId) : null;
        const connection = projectTarget ? this.connections.get(projectTarget.host) : null;
        const target = projectTarget && connection?.enabled
            ? resolveSshRuntimeTarget(projectTarget, connection)
            : null;
        if (!target)
            return { success: false, error: 'project_not_found' };
        const revision = this.connections.getIdentityRevision(target.host);
        const isCurrentTarget = () => {
            const currentProject = this.repository.getRuntimeTarget(projectId);
            const currentConnection = this.connections.get(target.host);
            return (currentProject &&
                currentConnection?.enabled &&
                this.connections.getIdentityRevision(target.host) === revision &&
                JSON.stringify(resolveSshRuntimeTarget(currentProject, currentConnection)) ===
                    JSON.stringify(target));
        };
        const content = await readUploadContent(input);
        if (!content.ok)
            return { success: false, error: content.error };
        const uploadId = this.createUploadId();
        try {
            const makeSpec = (ready) => {
                if (!isCurrentTarget())
                    throw new Error('upload_target_changed');
                return buildSshAttachmentUploadSpawnSpec(target, uploadId, input.fileName, content.bytes.length, ready);
            };
            const result = this.runCommand
                ? await this.runCommand(makeSpec(':'), content.bytes)
                : await sshExecution.run(target.endpoint, (ready) => makeSpec(ready).args.at(-1), {
                    input: content.bytes,
                    timeoutMs: UPLOAD_TIMEOUT_MS,
                });
            if (!isCurrentTarget())
                return { success: false, error: 'project_not_found' };
            const sha256 = createHash('sha256').update(content.bytes).digest('hex');
            const receivedSize = /^size=(\d+)$/mu.exec(result.stdout)?.[1];
            const receivedDigest = /^sha256=([a-f0-9]{64})$/mu.exec(result.stdout)?.[1];
            if (Number(receivedSize) !== content.bytes.length || receivedDigest !== sha256) {
                return { success: false, error: 'upload_failed' };
            }
            const remotePath = parseSshAttachmentUploadPath(result.stdout);
            const expectedSuffix = `/.minimax/ssh-uploads/${uploadId}/${input.fileName}`;
            if (!remotePath ||
                !isSafeAbsoluteRemotePath(remotePath) ||
                !remotePath.endsWith(expectedSuffix)) {
                return { success: false, error: 'upload_failed' };
            }
            return {
                success: true,
                remotePath,
                sizeBytes: content.bytes.byteLength,
                sha256,
            };
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error && error.message === 'upload_target_changed'
                    ? 'project_not_found'
                    : mapUploadError(error),
            };
        }
    }
}

function parseUploadInput(value) {
    if (!isRecord(value) || !isDesktopRuntimeId(value.runtimeId))
        return null;
    if (!sshProjectIdFromRuntimeId(value.runtimeId))
        return null;
    if (typeof value.fileName !== 'string' || !isSafeFileName(value.fileName))
        return null;
    if (value.mimeType !== undefined && typeof value.mimeType !== 'string')
        return null;
    if (value.declaredSizeBytes !== undefined &&
        (typeof value.declaredSizeBytes !== 'number' ||
            !Number.isSafeInteger(value.declaredSizeBytes) ||
            value.declaredSizeBytes < 0)) {
        return null;
    }
    if (!isRecord(value.source))
        return null;
    if (value.source.kind === 'local_path' && typeof value.source.path === 'string') {
        return {
            runtimeId: value.runtimeId,
            fileName: value.fileName,
            ...(typeof value.mimeType === 'string' ? { mimeType: value.mimeType } : {}),
            ...(typeof value.declaredSizeBytes === 'number'
                ? { declaredSizeBytes: value.declaredSizeBytes }
                : {}),
            source: { kind: 'local_path', path: value.source.path },
        };
    }
    if (value.source.kind === 'data_url' && typeof value.source.dataUrl === 'string') {
        return {
            runtimeId: value.runtimeId,
            fileName: value.fileName,
            ...(typeof value.mimeType === 'string' ? { mimeType: value.mimeType } : {}),
            ...(typeof value.declaredSizeBytes === 'number'
                ? { declaredSizeBytes: value.declaredSizeBytes }
                : {}),
            source: { kind: 'data_url', dataUrl: value.source.dataUrl },
        };
    }
    return null;
}
async function readUploadContent(input) {
    if (input.declaredSizeBytes !== undefined && input.declaredSizeBytes > MAX_SSH_ATTACHMENT_BYTES) {
        return { ok: false, error: 'file_too_large' };
    }
    if (input.source.kind === 'data_url') {
        const match = /^data:[^;,]*(?:;[^;,=]+=[^;,]*)*;base64,([A-Za-z0-9+/=\r\n]+)$/u.exec(input.source.dataUrl);
        if (!match?.[1])
            return { ok: false, error: 'unsupported_source' };
        const encoded = match[1].replace(/[\r\n]/gu, '');
        if (encoded.length > MAX_BASE64_ATTACHMENT_CHARS) {
            return { ok: false, error: 'file_too_large' };
        }
        const bytes = Buffer.from(encoded, 'base64');
        return bytes.byteLength <= MAX_SSH_ATTACHMENT_BYTES
            ? { ok: true, bytes }
            : { ok: false, error: 'file_too_large' };
    }
    if (!isAbsolute(input.source.path))
        return { ok: false, error: 'unsupported_source' };
    try {
        const info = await stat(input.source.path);
        if (!info.isFile())
            return { ok: false, error: 'file_not_found' };
        if (info.size > MAX_SSH_ATTACHMENT_BYTES)
            return { ok: false, error: 'file_too_large' };
        const bytes = await readFile(input.source.path);
        return bytes.byteLength <= MAX_SSH_ATTACHMENT_BYTES
            ? { ok: true, bytes }
            : { ok: false, error: 'file_too_large' };
    }
    catch {
        return { ok: false, error: 'file_not_found' };
    }
}
function isSafeFileName(value) {
    return (value.length > 0 &&
        value.length <= 255 &&
        value !== '.' &&
        value !== '..' &&
        !/[\\/\u0000-\u001f\u007f]/u.test(value));
}
function mapUploadError(error) {
    if (hasErrorCode(error, 'ENOENT'))
        return 'ssh_not_found';
    const classified = classifySshFailure(readStderr(error), false);
    switch (classified.code) {
        case 'ssh_auth_failed':
            return 'auth_failed';
        case 'ssh_host_key_untrusted':
            return 'host_key_untrusted';
        case 'ssh_host_unreachable':
            return 'host_unreachable';
        default:
            return 'upload_failed';
    }
}
function readStderr(error) {
    return error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string'
        ? error.stderr
        : '';
}
function hasErrorCode(error, code) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
