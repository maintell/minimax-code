import { createHash, randomBytes } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import { realpath, stat as promisesStat, lstat, rm, open, mkdir, mkdtemp, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PPTX_PREVIEW_LIMITS_V1, safePreviewDiagnosticV1 } from "@mavis/shared/document-preview";
import { issueSanitizedSourceHandle } from "./sanitized-source";
import { updatePptxNotes } from "./pptx-notes-writer";
import { commitPptxNotes } from "./pptx-notes-commit";
import { verifyTrustedAssetResolution } from "./asset-authority";
import { isTrustedWorkspaceCapability, verifyTrustedWorkspaceCapability, verifyTrustedWorkspaceFile } from "./workspace-authority";
const MAX_INPUT_BYTES = PPTX_PREVIEW_LIMITS_V1.maxInputBytes;
export let SANITIZED_STAGE_MAX_BYTES = 512 * 1024 * 1024;
/**
 * Source handles are cheap metadata, but they are still sender-owned state
 * and must have a bounded lifetime.  The defaults leave room for normal
 * multi-file preview sessions while making an untrusted renderer unable to
 * grow this registry without bound.
 */
export let SOURCE_REGISTRY_DEFAULTS = Object.freeze({
    maxSources: 256,
    maxSourcesPerSender: 64,
    maxStagedBytes: 1024 * 1024 * 1024,
    maxStagedBytesPerSender: SANITIZED_STAGE_MAX_BYTES,
    maxPendingStaging: 8,
    maxPendingStagingPerSender: 4,
    maxPendingDeletes: 256,
});
const MAX_FILE_NAME_CODE_UNITS = 256;
const MAX_MIME_TYPE_CODE_UNITS = 256;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const MIME_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/u;
function positiveSafeInteger(value, fallback) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
let documentPreviewModulePromise = null;
function importEsm(specifier) {
    if (process.env.VITEST === 'true') {
        return import(specifier);
    }
    // eslint-disable-next-line no-new-func -- Preserve native dynamic import in Electron's CJS main process.
    const dynamicImport = new Function('specifier', 'return import(specifier)');
    return dynamicImport(specifier);
}
function loadDocumentPreviewModule() {
    if (!documentPreviewModulePromise) {
        documentPreviewModulePromise = importEsm('@mavis/shared/document-preview');
    }
    return documentPreviewModulePromise;
}
function failure(code, message, retryable = false, detail) {
    return {
        ok: false,
        error: {
            schema: 'mavis.preview_error.v1',
            code,
            message: safePreviewDiagnosticV1(code, message),
            retryable,
            ...(detail ? { detail } : {}),
        },
    };
}
function isContained(workspace, candidate) {
    const relative = path.relative(workspace, candidate);
    return (relative === '' ||
        (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)));
}
function safeDisplayFileName(value) {
    if (typeof value !== 'string' || value.length === 0)
        return null;
    if (CONTROL_CHARACTER.test(value) || /[\\/]/u.test(value))
        return null;
    if (/^[A-Za-z]:/u.test(value) || value.startsWith('\\\\'))
        return null;
    if (value.length <= MAX_FILE_NAME_CODE_UNITS)
        return value;
    // Keep the allowlisted extension when truncating a display label.  Losing
    // it would make the opaque staged copy look like an unknown binary to the
    // native/QuickLook consumers even though the source was admitted by the
    // extension contract.
    const extension = path.extname(value);
    if (extension.length > 0 && extension.length < MAX_FILE_NAME_CODE_UNITS) {
        return `${value.slice(0, MAX_FILE_NAME_CODE_UNITS - extension.length)}${extension}`;
    }
    return value.slice(0, MAX_FILE_NAME_CODE_UNITS);
}
function safeMimeType(value) {
    if (typeof value !== 'string' ||
        value.length === 0 ||
        value.length > MAX_MIME_TYPE_CODE_UNITS ||
        CONTROL_CHARACTER.test(value) ||
        !MIME_TYPE.test(value)) {
        return null;
    }
    return value;
}
function safeRelativeFilePath(value) {
    return (typeof value === 'string' &&
        value.length > 0 &&
        value.length <= 4096 &&
        !CONTROL_CHARACTER.test(value) &&
        !path.posix.isAbsolute(value) &&
        !path.win32.isAbsolute(value) &&
        !/^[A-Za-z]:/u.test(value) &&
        !value.startsWith('\\\\'));
}
function previewLineageDigest(namespace, parts) {
    const digest = createHash('sha256');
    digest.update(namespace);
    for (const part of parts) {
        digest.update('\u0000');
        digest.update(part);
    }
    return digest.digest('hex');
}
function normalizedWorkspaceRelativePath(workspace, file) {
    const relative = path.relative(workspace, file);
    if (relative === '' ||
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)) {
        return null;
    }
    const normalized = relative.split(path.sep).join('/');
    return safeRelativeFilePath(normalized) ? normalized : null;
}
function sameStat(left, right) {
    return (left.size === right.size &&
        left.mtimeMs === right.mtimeMs &&
        left.ino === right.ino &&
        left.dev === right.dev);
}
function statFingerprint(stat) {
    return { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, dev: stat.dev };
}
async function hashAndReadHandle(handle, collectBytes, maxBytes, signal) {
    if (signal?.aborted)
        return null;
    const before = await handle.stat();
    if (signal?.aborted ||
        !before.isFile() ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 0 ||
        before.size > maxBytes)
        return null;
    const hash = createHash('sha256');
    const chunks = [];
    let totalBytes = 0;
    const stream = createReadStream('', {
        fd: handle.fd,
        autoClose: false,
        start: 0,
    });
    const abortStream = () => stream.destroy();
    signal?.addEventListener('abort', abortStream, { once: true });
    try {
        for await (const chunk of stream) {
            if (signal?.aborted)
                return null;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (bytes.byteLength > maxBytes - totalBytes) {
                stream.destroy();
                return null;
            }
            totalBytes += bytes.byteLength;
            hash.update(bytes);
            if (collectBytes)
                chunks.push(bytes);
        }
    }
    finally {
        signal?.removeEventListener('abort', abortStream);
    }
    if (signal?.aborted)
        return null;
    const after = await handle.stat();
    const beforeFingerprint = statFingerprint(before);
    const afterFingerprint = statFingerprint(after);
    if (beforeFingerprint.size !== afterFingerprint.size ||
        beforeFingerprint.mtimeMs !== afterFingerprint.mtimeMs ||
        beforeFingerprint.ino !== afterFingerprint.ino ||
        beforeFingerprint.dev !== afterFingerprint.dev) {
        return null;
    }
    if (afterFingerprint.size !== totalBytes || totalBytes > maxBytes)
        return null;
    return {
        fingerprint: { ...afterFingerprint, sha256: hash.digest('hex') },
        ...(collectBytes ? { bytes: new Uint8Array(Buffer.concat(chunks, totalBytes)) } : {}),
    };
}
function openFlags() {
    if (process.platform === 'win32' || constants.O_NOFOLLOW === undefined)
        return constants.O_RDONLY;
    return constants.O_RDONLY | constants.O_NOFOLLOW;
}
/**
 * Compare the platform file identity exposed by a pathname and an opened fd.
 * Some Windows filesystems report zero for dev or ino, which means that field
 * is unavailable rather than that the files differ.  Enforce equality only
 * when both sides provide a non-zero value.
 */
export function openedFileIdentityMatches(pathnameIdentity, handleIdentity) {
    const devicesMatch = pathnameIdentity.dev === 0n ||
        handleIdentity.dev === 0n ||
        pathnameIdentity.dev === handleIdentity.dev;
    const inodesMatch = pathnameIdentity.ino === 0n ||
        handleIdentity.ino === 0n ||
        pathnameIdentity.ino === handleIdentity.ino;
    return devicesMatch && inodesMatch;
}
export async function verifyOpenedFileContainment(handle, workspace, pathname) {
    try {
        const firstCanonicalPath = await realpath(pathname);
        if (!isContained(workspace, firstCanonicalPath))
            return false;
        const [pathnameStat, handleStat] = await Promise.all([
            promisesStat(firstCanonicalPath, { bigint: true }),
            handle.stat({ bigint: true }),
        ]);
        if (!pathnameStat.isFile() || !handleStat.isFile())
            return false;
        if (!openedFileIdentityMatches(pathnameStat, handleStat))
            return false;
        const secondCanonicalPath = await realpath(pathname);
        return secondCanonicalPath === firstCanonicalPath;
    }
    catch {
        return false;
    }
}
async function verifyWorkspaceIdentity(workspacePath, expected) {
    try {
        const canonicalPath = await realpath(workspacePath);
        if (canonicalPath !== workspacePath)
            return false;
        const info = await lstat(canonicalPath, { bigint: true });
        return (info.isDirectory() &&
            !info.isSymbolicLink() &&
            info.dev.toString() === expected.dev &&
            info.ino.toString() === expected.ino);
    }
    catch {
        return false;
    }
}
const OOXML_MIME_BY_EXTENSION = {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const LEGACY_MIME_BY_EXTENSION = {
    ppt: 'application/vnd.ms-powerpoint',
    key: 'application/vnd.apple.keynote',
    pptx: OOXML_MIME_BY_EXTENSION.pptx,
};
const SYSTEM_OPEN_OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/u;
function officeExtension(value, kind = 'ooxml') {
    const extension = path.extname(value).slice(1).toLowerCase();
    const map = kind === 'legacy' ? LEGACY_MIME_BY_EXTENSION : OOXML_MIME_BY_EXTENSION;
    return Object.prototype.hasOwnProperty.call(map, extension) ? extension : null;
}
function zipContainerMagic(value) {
    return (value.length >= 4 &&
        value[0] === 0x50 &&
        value[1] === 0x4b &&
        ((value[2] === 0x03 && value[3] === 0x04) ||
            (value[2] === 0x05 && value[3] === 0x06) ||
            (value[2] === 0x07 && value[3] === 0x08)));
}
function oleContainerMagic(value) {
    const magic = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    return value.length >= magic.length && magic.every((byte, index) => value[index] === byte);
}
function legacyContainerMagic(extension, value) {
    return extension === 'ppt' ? oleContainerMagic(value) : zipContainerMagic(value);
}
export class DocumentPreviewSourceRegistry {
    async savePptxNotes(senderId, input, ownerToken) {
        if (!input || typeof input !== 'object')
            return failure('invalid_request', 'Invalid notes save');
        const request = input;
        if (typeof request.sourceId !== 'string' ||
            typeof request.contentSha256 !== 'string' ||
            !Number.isSafeInteger(request.sourceGeneration) ||
            !Array.isArray(request.edits) ||
            request.edits.length === 0 ||
            request.edits.length > 100 ||
            request.edits.some((edit) => !edit ||
                !Number.isSafeInteger(edit.slideIndex) ||
                edit.slideIndex < 0 ||
                typeof edit.text !== 'string') ||
            request.edits.reduce((total, edit) => total + Buffer.byteLength(edit.text), 0) >
                2 * 1024 * 1024) {
            return failure('invalid_request', 'Invalid notes save');
        }
        const entry = this.getOwnedEntry(senderId, request.sourceId, ownerToken);
        if (!entry)
            return failure('source_not_found', 'Notes source unavailable');
        if (entry.source.contentSha256 !== request.contentSha256 ||
            entry.generation !== request.sourceGeneration ||
            this.notesWrites.has(entry.absolutePath)) {
            return failure('source_mutated', 'Notes source has changed');
        }
        this.notesWrites.add(entry.absolutePath);
        let lease = null;
        try {
            lease = await this.acquireSelectionResolutionSource(senderId, request.sourceId, request.contentSha256, request.sourceGeneration, ownerToken);
            if (!lease)
                return failure('source_mutated', 'Notes source has changed');
            const read = await this.read(senderId, request.sourceId, MAX_INPUT_BYTES, ownerToken);
            if (!read.ok)
                return read;
            const original = Buffer.from(read.value.bytes);
            const updated = await updatePptxNotes(original, request.edits);
            const fingerprint = await commitPptxNotes({
                file: lease.path,
                original,
                updated,
                assetSidecar: entry.assetSidecar,
                validate: async () => Boolean(await lease?.validate()) &&
                    (await this.verifySourceHash(senderId, request.sourceId, request.contentSha256, ownerToken)),
            });
            const sha256 = createHash('sha256').update(updated).digest('hex');
            entry.fingerprint = { ...statFingerprint(fingerprint), sha256 };
            entry.generation += 1;
            entry.systemOpenNonce = randomBytes(16).toString('hex');
            entry.source = {
                ...entry.source,
                sizeBytes: updated.length,
                modifiedAtMs: Math.max(0, Math.trunc(fingerprint.mtimeMs)),
                contentSha256: `sha256:${sha256}`,
                lineageId: `lineage.v1.${previewLineageDigest('mavis.preview.source.lineage.v1', [entry.source.lineageScopeId, sha256])}`,
            };
            return { ok: true, value: { ...entry.source, sourceGeneration: entry.generation } };
        }
        catch (error) {
            return failure(error instanceof Error && error.message === 'source_mutated'
                ? 'source_mutated'
                : 'transform_failed', 'Notes could not be saved', true);
        }
        finally {
            await lease?.release();
            this.notesWrites.delete(entry.absolutePath);
        }
    }
    constructor(options = {}) {
        this.notesWrites = new Set();
        this.entries = new Map();
        this.pendingSources = new Map();
        this.pendingStages = new Map();
        this.stagedCopiesByPath = new Map();
        this.pendingDeletes = new Map();
        this.systemOpenRetentions = new Map();
        /**
         * Asset claims have no source nonce until main has staged them. Keep an
         * owner-scoped lifecycle so the renderer-facing asset identity can be
         * acquired only once, then hand back the rotated source claim on success.
         */
        this.systemOpenAssetClaims = new Map();
        this.systemOpenRetentionTimer = null;
        this.stagedBytes = 0;
        this.pendingStagedBytes = 0;
        this.stagedBytesBySender = new Map();
        this.pendingStagedBytesBySender = new Map();
        this.tempRootPromise = null;
        this.maxSanitizedBytes = Math.min(SANITIZED_STAGE_MAX_BYTES, positiveSafeInteger(options.maxSanitizedBytes, SANITIZED_STAGE_MAX_BYTES));
        this.maxSources = positiveSafeInteger(options.maxSources, SOURCE_REGISTRY_DEFAULTS.maxSources);
        this.maxSourcesPerSender = Math.min(this.maxSources, positiveSafeInteger(options.maxSourcesPerSender, SOURCE_REGISTRY_DEFAULTS.maxSourcesPerSender));
        this.maxStagedBytes = positiveSafeInteger(options.maxStagedBytes, SOURCE_REGISTRY_DEFAULTS.maxStagedBytes);
        this.maxStagedBytesPerSender = Math.min(this.maxStagedBytes, positiveSafeInteger(options.maxStagedBytesPerSender, SOURCE_REGISTRY_DEFAULTS.maxStagedBytesPerSender));
        this.maxPendingStaging = positiveSafeInteger(options.maxPendingStaging, SOURCE_REGISTRY_DEFAULTS.maxPendingStaging);
        this.maxPendingStagingPerSender = Math.min(this.maxPendingStaging, positiveSafeInteger(options.maxPendingStagingPerSender, SOURCE_REGISTRY_DEFAULTS.maxPendingStagingPerSender));
        this.maxPendingDeletes = positiveSafeInteger(options.maxPendingDeletes, SOURCE_REGISTRY_DEFAULTS.maxPendingDeletes);
        this.removePath =
            options.removePath ?? ((target, recursive) => rm(target, { recursive, force: true }));
        this.cleanupRetryDelayMs = options.cleanupRetryDelayMs ?? 10;
        this.leaseDrainTimeoutMs = positiveSafeInteger(options.leaseDrainTimeoutMs, 5000);
        this.systemOpenRetentionMs = positiveSafeInteger(options.systemOpenRetentionMs, 60000);
    }
    async open(senderId, input, ownerToken) {
        return this.openWithKind(senderId, input, 'ooxml', ownerToken);
    }
    async openLegacy(senderId, input, ownerToken) {
        return this.openWithKind(senderId, input, 'legacy', ownerToken);
    }
    async openWithKind(senderId, input, sourceKind, ownerToken) {
        if (!Number.isSafeInteger(senderId) ||
            senderId < 0 ||
            !input ||
            typeof input !== 'object' ||
            (ownerToken !== undefined && (typeof ownerToken !== 'object' || ownerToken === null))) {
            return failure('invalid_request', 'Invalid document preview source request');
        }
        const assetResolution = input.assetResolution;
        if (assetResolution && !(await verifyTrustedAssetResolution(assetResolution, senderId))) {
            return failure('source_outside_workspace', 'Document preview asset is not authorized', false, 'asset_verify_failed');
        }
        const rawFileName = assetResolution
            ? assetResolution.fileName
            : typeof input.fileName === 'string'
                ? input.fileName
                : '';
        const fileName = safeDisplayFileName(rawFileName);
        const claimedMimeType = safeMimeType(assetResolution ? assetResolution.mimeType : input.mimeType);
        const claimedWorkspaceDir = typeof input.workspaceDir === 'string' ? input.workspaceDir : null;
        const claimedFilePath = safeRelativeFilePath(input.filePath) ? input.filePath : null;
        if (!fileName ||
            !claimedMimeType ||
            (!assetResolution && (!claimedWorkspaceDir || !claimedFilePath))) {
            return failure('invalid_request', 'Invalid document preview source metadata');
        }
        // The extension is derived from the claimed relative path and must agree
        // with the display metadata; the MIME value is never trusted as a file
        // type and is replaced with the canonical type below.
        const claimedExtension = officeExtension(assetResolution ? assetResolution.absolutePath : claimedFilePath, sourceKind);
        const displayExtension = officeExtension(fileName, sourceKind);
        if (!claimedExtension || !displayExtension || claimedExtension !== displayExtension) {
            return failure('invalid_request', sourceKind === 'legacy'
                ? 'Document preview source must be an allowlisted legacy presentation'
                : 'Document preview source must be an OOXML office file');
        }
        let realWorkspace;
        let workspaceIdentity;
        try {
            if (assetResolution) {
                realWorkspace = assetResolution.assetRoot;
                const workspaceInfo = await lstat(realWorkspace, { bigint: true });
                if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink()) {
                    return failure('source_outside_workspace', 'Document preview asset root is not authorized', false, 'asset_root_invalid');
                }
                workspaceIdentity = {
                    dev: workspaceInfo.dev.toString(),
                    ino: workspaceInfo.ino.toString(),
                };
            }
            else if (input.workspaceCapability !== undefined) {
                let claimedWorkspacePath = null;
                try {
                    claimedWorkspacePath = await realpath(claimedWorkspaceDir);
                }
                catch {
                    claimedWorkspacePath = null;
                }
                if (!isTrustedWorkspaceCapability(input.workspaceCapability) ||
                    claimedWorkspacePath !== input.workspaceCapability.canonicalPath ||
                    !(await verifyTrustedWorkspaceCapability(input.workspaceCapability))) {
                    return failure('source_outside_workspace', 'Document preview workspace is not authorized', false, 'workspace_capability_invalid');
                }
                realWorkspace = input.workspaceCapability.canonicalPath;
                workspaceIdentity = input.workspaceCapability.identity;
            }
            else {
                realWorkspace = await realpath(claimedWorkspaceDir);
                const workspaceInfo = await lstat(realWorkspace, { bigint: true });
                if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink()) {
                    return failure('invalid_request', 'Document preview workspace must be a directory');
                }
                workspaceIdentity = {
                    dev: workspaceInfo.dev.toString(),
                    ino: workspaceInfo.ino.toString(),
                };
            }
            if (!(await verifyWorkspaceIdentity(realWorkspace, workspaceIdentity))) {
                return failure('invalid_request', 'Document preview workspace must be a directory');
            }
        }
        catch {
            return failure('invalid_request', 'Document preview workspace is unavailable');
        }
        let realFile;
        try {
            realFile = assetResolution
                ? await realpath(assetResolution.absolutePath)
                : await realpath(path.resolve(realWorkspace, claimedFilePath));
        }
        catch {
            return failure('source_not_found', 'Document preview source was not found');
        }
        if (assetResolution && realFile !== assetResolution.absolutePath) {
            return failure('source_mutated', 'Document preview asset changed while opening');
        }
        if (input.workspaceCapability &&
            !(await verifyTrustedWorkspaceFile(input.workspaceCapability, realFile))) {
            return failure('source_outside_workspace', 'Document preview file is not authorized', false, 'file_identity_changed');
        }
        if (!isContained(realWorkspace, realFile)) {
            return failure('source_outside_workspace', 'Document preview source is outside the workspace', false, 'outside_after_realpath');
        }
        const actualExtension = officeExtension(realFile, sourceKind);
        if (!actualExtension || actualExtension !== claimedExtension) {
            return failure('invalid_request', 'Document preview source extension is not allowed');
        }
        const sourceReservation = this.reserveSource(senderId, ownerToken);
        if (!sourceReservation) {
            return failure('resource_limit_exceeded', 'Document preview source limit reached', true);
        }
        let sourcePublished = false;
        let handle = null;
        try {
            handle = await open(realFile, openFlags());
            const authorizedFile = input.workspaceCapability?.file;
            if (authorizedFile) {
                const identity = await handle.stat({ bigint: true });
                if (identity.dev.toString() !== authorizedFile.dev ||
                    identity.ino.toString() !== authorizedFile.ino ||
                    identity.size.toString() !== authorizedFile.size ||
                    identity.mtimeMs.toString() !== authorizedFile.mtimeMs ||
                    (authorizedFile.ctimeMs !== undefined &&
                        identity.ctimeMs.toString() !== authorizedFile.ctimeMs)) {
                    return failure('source_mutated', 'Document preview delivered file changed while opening');
                }
            }
            const initialStat = await handle.stat();
            if (!initialStat.isFile()) {
                return failure('invalid_request', 'Document preview source must be a regular file');
            }
            if (initialStat.size > MAX_INPUT_BYTES) {
                return failure('source_too_large', 'Document preview source exceeds the input limit');
            }
            const rootStillSame = await verifyWorkspaceIdentity(realWorkspace, workspaceIdentity);
            if (!rootStillSame) {
                return failure('source_mutated', 'Document preview workspace changed while opening');
            }
            // The IPC path always supplies a main-owned capability and therefore
            // gets the container check. Direct main-process unit consumers may use
            // synthetic bytes while exercising lifecycle plumbing; those callers do
            // not cross the renderer trust boundary.
            if (input.workspaceCapability || assetResolution) {
                const magic = Buffer.allocUnsafe(sourceKind === 'legacy' && claimedExtension === 'ppt' ? 8 : 4);
                const magicRead = await handle.read(magic, 0, magic.byteLength, 0);
                const validMagic = magicRead.bytesRead < magic.byteLength
                    ? false
                    : sourceKind === 'legacy'
                        ? legacyContainerMagic(claimedExtension, magic)
                        : zipContainerMagic(magic);
                if (!validMagic) {
                    return failure('invalid_source_archive', sourceKind === 'legacy'
                        ? 'Document preview source container is invalid'
                        : 'Document preview source is not an OOXML archive');
                }
            }
            const containedBeforeHash = await verifyOpenedFileContainment(handle, realWorkspace, realFile);
            if (!containedBeforeHash) {
                return failure('source_mutated', 'Document preview source changed while opening');
            }
            const hashed = await hashAndReadHandle(handle, false, MAX_INPUT_BYTES);
            if (!hashed)
                return failure('source_mutated', 'Document preview source changed while opening');
            if (assetResolution &&
                (hashed.fingerprint.size !== assetResolution.bytes ||
                    hashed.fingerprint.sha256 !== assetResolution.sha256)) {
                return failure('source_mutated', 'Document preview asset changed while opening');
            }
            if (input.workspaceCapability?.file &&
                !(await verifyTrustedWorkspaceFile(input.workspaceCapability, realFile))) {
                return failure('source_mutated', 'Document preview selected file changed while opening');
            }
            const containedAfterHash = await verifyOpenedFileContainment(handle, realWorkspace, realFile);
            if (!containedAfterHash) {
                return failure('source_mutated', 'Document preview source changed while opening');
            }
            if (!(await verifyWorkspaceIdentity(realWorkspace, workspaceIdentity))) {
                return failure('source_mutated', 'Document preview workspace changed while opening');
            }
            const sourceId = randomBytes(16).toString('hex');
            const workspaceRelativePath = assetResolution
                ? null
                : normalizedWorkspaceRelativePath(realWorkspace, realFile);
            if (!assetResolution && !workspaceRelativePath) {
                return failure('source_mutated', 'Document preview source identity changed while opening');
            }
            const lineageScopeId = assetResolution
                ? `lineage_scope.v1.${previewLineageDigest('mavis.preview.asset.scope.v1', [
                    assetResolution.assetId,
                    assetResolution.sessionId ?? '',
                ])}`
                : `lineage_scope.v1.${previewLineageDigest('mavis.preview.workspace.scope.v1', [
                    workspaceIdentity.dev,
                    workspaceIdentity.ino,
                    workspaceRelativePath,
                ])}`;
            const lineageId = `lineage.v1.${previewLineageDigest('mavis.preview.source.lineage.v1', [
                lineageScopeId,
                hashed.fingerprint.sha256,
            ])}`;
            const source = {
                schema: 'mavis.preview_source.v1',
                sourceId,
                lineageId,
                lineageScopeId,
                fileName,
                mimeType: (sourceKind === 'legacy' ? LEGACY_MIME_BY_EXTENSION : OOXML_MIME_BY_EXTENSION)[claimedExtension],
                sizeBytes: hashed.fingerprint.size,
                modifiedAtMs: Math.max(0, Math.trunc(hashed.fingerprint.mtimeMs)),
                contentSha256: `sha256:${hashed.fingerprint.sha256}`,
            };
            try {
                const assertPreviewSourceV1 = (await loadDocumentPreviewModule()).assertPreviewSourceV1;
                assertPreviewSourceV1(source);
            }
            catch {
                return failure('invalid_request', 'Invalid document preview source metadata');
            }
            // A sender teardown/releaseAll can revoke an in-flight reservation while
            // the file is being hashed.  Do not publish a source after that boundary.
            const liveReservation = this.pendingSources.get(sourceReservation);
            if (!liveReservation ||
                liveReservation.senderId !== senderId ||
                liveReservation.ownerToken !== ownerToken) {
                return failure('source_not_found', 'Document preview source was released while opening');
            }
            this.pendingSources.delete(sourceReservation);
            this.entries.set(sourceId, {
                ...(assetResolution ? { assetSidecar: assetResolution.sidecarPath } : {}),
                senderId,
                ownerToken,
                source,
                absolutePath: realFile,
                fingerprint: hashed.fingerprint,
                workspacePath: realWorkspace,
                workspaceIdentity,
                sourceKind,
                ...(typeof input.sessionId === 'string' && SYSTEM_OPEN_OPAQUE_ID.test(input.sessionId)
                    ? { sessionId: input.sessionId }
                    : {}),
                generation: 0,
                systemOpenNonce: randomBytes(16).toString('hex'),
                systemOpenClaimState: 'issued',
                systemOpenRetained: false,
                systemOpenLeaseCount: 0,
                systemOpenReleaseRequested: false,
            });
            sourcePublished = true;
            return { ok: true, value: source };
        }
        catch {
            return failure('source_not_found', 'Document preview source could not be opened');
        }
        finally {
            if (!sourcePublished)
                this.pendingSources.delete(sourceReservation);
            await handle?.close().catch(() => undefined);
        }
    }
    async read(senderId, sourceId, maxBytes, ownerToken) {
        const entry = this.getOwnedEntry(senderId, sourceId, ownerToken);
        if (!entry)
            return failure('source_not_found', 'Document preview source was not found');
        if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || entry.source.sizeBytes > maxBytes) {
            return failure('resource_limit_exceeded', 'Document preview read exceeds the requested limit');
        }
        let handle = null;
        try {
            if (!(await verifyWorkspaceIdentity(entry.workspacePath, entry.workspaceIdentity))) {
                return failure('source_mutated', 'Document preview workspace changed after it was opened');
            }
            handle = await open(entry.absolutePath, openFlags());
            if (!(await verifyOpenedFileContainment(handle, entry.workspacePath, entry.absolutePath))) {
                return failure('source_mutated', 'Document preview source changed after it was opened');
            }
            const hashed = await hashAndReadHandle(handle, true, Math.min(maxBytes, MAX_INPUT_BYTES));
            if (!hashed ||
                !sameStat(entry.fingerprint, hashed.fingerprint) ||
                hashed.fingerprint.sha256 !== entry.fingerprint.sha256 ||
                !hashed.bytes) {
                return failure('source_mutated', 'Document preview source changed after it was opened');
            }
            if (!(await verifyOpenedFileContainment(handle, entry.workspacePath, entry.absolutePath))) {
                return failure('source_mutated', 'Document preview source changed after it was opened');
            }
            if (!(await verifyWorkspaceIdentity(entry.workspacePath, entry.workspaceIdentity))) {
                return failure('source_mutated', 'Document preview workspace changed after it was opened');
            }
            return {
                ok: true,
                value: {
                    bytes: hashed.bytes,
                    removedExternalRelationshipCount: 0,
                    rejectedEmbeddedResourceCount: 0,
                },
            };
        }
        catch {
            return failure('source_mutated', 'Document preview source changed after it was opened');
        }
        finally {
            await handle?.close().catch(() => undefined);
        }
    }
    /**
     * Acquire the original PPTX bytes for the Safe OPC core lane. This is
     * separate from read()/stage(): no sanitizer, re-zip, or staged copy is
     * reachable through this lease.
     */
    async acquireOriginalSource(senderId, sourceId, expectedGeneration, ownerToken, signal) {
        const entry = this.getOwnedEntry(senderId, sourceId, ownerToken);
        if (!entry ||
            entry.generation !== expectedGeneration ||
            entry.sourceKind !== 'ooxml' ||
            entry.source.mimeType !==
                'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
            signal?.aborted) {
            return null;
        }
        let handle = null;
        try {
            if (!(await verifyWorkspaceIdentity(entry.workspacePath, entry.workspaceIdentity))) {
                return null;
            }
            handle = await open(entry.absolutePath, openFlags());
            if (!(await verifyOpenedFileContainment(handle, entry.workspacePath, entry.absolutePath))) {
                return null;
            }
            const hashed = await hashAndReadHandle(handle, false, MAX_INPUT_BYTES, signal);
            if (signal?.aborted ||
                !hashed ||
                !sameStat(entry.fingerprint, hashed.fingerprint) ||
                hashed.fingerprint.sha256 !== entry.fingerprint.sha256 ||
                this.entries.get(sourceId) !== entry ||
                entry.generation !== expectedGeneration) {
                return null;
            }
            const ownedHandle = handle;
            handle = null;
            let released = false;
            const isCurrent = () => !released &&
                this.entries.get(sourceId) === entry &&
                entry.senderId === senderId &&
                entry.ownerToken === ownerToken &&
                entry.generation === expectedGeneration &&
                !entry.systemOpenRetained &&
                !entry.systemOpenReleaseRequested;
            return Object.freeze({
                sourceId,
                sourceGeneration: expectedGeneration,
                sourceSha256: entry.source.contentSha256,
                sourceSizeBytes: entry.source.sizeBytes,
                read: async (offset, maxBytes, signal) => {
                    if (!isCurrent() ||
                        signal?.aborted ||
                        !Number.isSafeInteger(offset) ||
                        offset < 0 ||
                        !Number.isSafeInteger(maxBytes) ||
                        maxBytes <= 0 ||
                        maxBytes > MAX_INPUT_BYTES) {
                        throw new Error(signal?.aborted ? 'source_read_cancelled' : 'source_not_current');
                    }
                    const remaining = entry.source.sizeBytes - offset;
                    if (remaining <= 0)
                        return new Uint8Array();
                    const buffer = Buffer.allocUnsafe(Math.min(maxBytes, remaining));
                    const result = await ownedHandle.read(buffer, 0, buffer.byteLength, offset);
                    if (!isCurrent() || signal?.aborted) {
                        throw new Error(signal?.aborted ? 'source_read_cancelled' : 'source_not_current');
                    }
                    return new Uint8Array(buffer.buffer, buffer.byteOffset, result.bytesRead).slice();
                },
                validate: async () => {
                    if (!isCurrent())
                        return false;
                    try {
                        const current = statFingerprint(await ownedHandle.stat());
                        return (sameStat(entry.fingerprint, current) &&
                            (await verifyOpenedFileContainment(ownedHandle, entry.workspacePath, entry.absolutePath)) &&
                            (await verifyWorkspaceIdentity(entry.workspacePath, entry.workspaceIdentity)) &&
                            isCurrent());
                    }
                    catch {
                        return false;
                    }
                },
                release: async () => {
                    if (released)
                        return;
                    released = true;
                    await ownedHandle.close().catch(() => undefined);
                },
            });
        }
        catch {
            return null;
        }
        finally {
            await handle?.close().catch(() => undefined);
        }
    }
    async acquireSelectionResolutionSource(senderId, sourceId, expectedSha256, expectedGeneration, ownerToken) {
        const entry = this.getOwnedEntry(senderId, sourceId, ownerToken);
        if (!entry ||
            entry.generation !== expectedGeneration ||
            entry.source.contentSha256 !== expectedSha256 ||
            entry.sourceKind !== 'ooxml' ||
            entry.source.mimeType !==
                'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
            return null;
        }
        let handle = null;
        try {
            if (!(await verifyWorkspaceIdentity(entry.workspacePath, entry.workspaceIdentity))) {
                return null;
            }
            handle = await open(entry.absolutePath, openFlags());
            if (!(await verifyOpenedFileContainment(handle, entry.workspacePath, entry.absolutePath))) {
                return null;
            }
            const hashed = await hashAndReadHandle(handle, false, MAX_INPUT_BYTES);
            if (!hashed ||
                !sameStat(entry.fingerprint, hashed.fingerprint) ||
                `sha256:${hashed.fingerprint.sha256}` !== expectedSha256 ||
                this.entries.get(sourceId) !== entry ||
                entry.generation !== expectedGeneration) {
                return null;
            }
            const ownedHandle = handle;
            handle = null;
            let released = false;
            const isCurrent = () => !released &&
                this.entries.get(sourceId) === entry &&
                entry.senderId === senderId &&
                entry.ownerToken === ownerToken &&
                entry.generation === expectedGeneration &&
                entry.source.contentSha256 === expectedSha256 &&
                !entry.systemOpenRetained &&
                !entry.systemOpenReleaseRequested;
            return Object.freeze({
                path: entry.absolutePath,
                sourceId,
                sourceGeneration: expectedGeneration,
                sourceSha256: expectedSha256,
                validate: async () => {
                    if (!isCurrent())
                        return false;
                    try {
                        const fingerprint = statFingerprint(await ownedHandle.stat());
                        return (sameStat(entry.fingerprint, fingerprint) &&
                            (await verifyOpenedFileContainment(ownedHandle, entry.workspacePath, entry.absolutePath)) &&
                            (await verifyWorkspaceIdentity(entry.workspacePath, entry.workspaceIdentity)) &&
                            isCurrent());
                    }
                    catch {
                        return false;
                    }
                },
                release: async () => {
                    if (released)
                        return;
                    released = true;
                    await ownedHandle.close().catch(() => undefined);
                },
            });
        }
        catch {
            return null;
        }
        finally {
            await handle?.close().catch(() => undefined);
        }
    }
    /**
     * Re-open and hash the original source without exposing its path.  Native
     * transforms call this immediately before and after conversion so a source
     * replacement, release, or in-place mutation invalidates the result.
     */
    async verifySourceHash(senderId, sourceId, expectedSha256, ownerToken) {
        const entry = this.getOwnedEntry(senderId, sourceId, ownerToken);
        if (!entry || entry.source.contentSha256 !== expectedSha256)
            return false;
        let handle = null;
        try {
            if (!(await verifyWorkspaceIdentity(entry.workspacePath, entry.workspaceIdentity))) {
                return false;
            }
            handle = await open(entry.absolutePath, openFlags());
            if (!(await verifyOpenedFileContainment(handle, entry.workspacePath, entry.absolutePath))) {
                return false;
            }
            const hashed = await hashAndReadHandle(handle, false, MAX_INPUT_BYTES);
            if (!hashed ||
                !sameStat(entry.fingerprint, hashed.fingerprint) ||
                `sha256:${hashed.fingerprint.sha256}` !== expectedSha256) {
                return false;
            }
            return ((await verifyOpenedFileContainment(handle, entry.workspacePath, entry.absolutePath)) &&
                (await verifyWorkspaceIdentity(entry.workspacePath, entry.workspaceIdentity)));
        }
        catch {
            return false;
        }
        finally {
            await handle?.close().catch(() => undefined);
        }
    }
    async acquireSystemOpenSource(senderId, claim, ownerToken) {
        if (claim?.kind !== 'source' ||
            !SYSTEM_OPEN_OPAQUE_ID.test(claim.sourceId) ||
            !SYSTEM_OPEN_OPAQUE_ID.test(claim.sessionId) ||
            !/^sha256:[a-f0-9]{64}$/u.test(claim.contentSha256) ||
            !Number.isSafeInteger(claim.generation) ||
            claim.generation < 0 ||
            !SYSTEM_OPEN_OPAQUE_ID.test(claim.nonce)) {
            return null;
        }
        // A successful shell handoff moves the source into bounded retention.  The
        // renderer must still be able to redeem the freshly rotated claim during
        // that window, while the original claim remains invalidated by the nonce
        // rotation.  `getOwnedEntry` intentionally hides retained entries from
        // normal source/read/stage APIs, so system-open has its own guarded lookup.
        const entry = this.entries.get(claim.sourceId);
        if (!entry ||
            entry.senderId !== senderId ||
            (ownerToken !== undefined && entry.ownerToken !== ownerToken) ||
            entry.sessionId !== claim.sessionId ||
            entry.source.contentSha256 !== claim.contentSha256 ||
            entry.generation !== claim.generation ||
            entry.systemOpenNonce !== claim.nonce ||
            entry.systemOpenClaimState !== 'issued' ||
            (entry.systemOpenRetained && !this.isLiveSystemOpenRetention(claim.sourceId, senderId)) ||
            (!entry.systemOpenRetained && entry.systemOpenReleaseRequested)) {
            return null;
        }
        // JavaScript executes this mutation before the first await below. It is
        // the atomic one-shot claim boundary: concurrent exchanges observe
        // `in-flight` and fail before any external-open side effect can run.
        entry.systemOpenClaimState = 'in-flight';
        const generation = entry.generation;
        const isCurrent = () => this.entries.get(claim.sourceId) === entry &&
            entry.senderId === senderId &&
            entry.sessionId === claim.sessionId &&
            entry.source.contentSha256 === claim.contentSha256 &&
            entry.generation === claim.generation &&
            entry.systemOpenNonce === claim.nonce &&
            entry.systemOpenClaimState === 'in-flight' &&
            (!entry.systemOpenRetained || this.isLiveSystemOpenRetention(claim.sourceId, senderId));
        const stagedKind = entry.legacyCopy && !entry.legacyCopy.retired && entry.legacyCopy.generation === generation
            ? 'legacy'
            : entry.sanitizedCopy &&
                !entry.sanitizedCopy.retired &&
                entry.sanitizedCopy.generation === generation
                ? 'sanitized'
                : null;
        const stagedCopy = stagedKind === 'legacy'
            ? entry.legacyCopy
            : stagedKind === 'sanitized'
                ? entry.sanitizedCopy
                : undefined;
        const stagedLease = stagedKind
            ? this.acquireStagedCopy(senderId, claim.sourceId, stagedKind, true)
            : null;
        // The shell may only receive a main-owned staged copy.  Falling back to
        // the original workspace path would expose an untrusted filesystem path
        // and bypass the immutable-copy lifetime guarantees of this lease.
        if (!stagedLease) {
            if (this.entries.get(claim.sourceId) === entry)
                entry.systemOpenClaimState = 'consumed';
            return null;
        }
        const validate = async () => {
            if (!isCurrent())
                return false;
            const valid = await stagedLease.validate();
            return valid && isCurrent();
        };
        if (!(await validate())) {
            if (this.entries.get(claim.sourceId) === entry)
                entry.systemOpenClaimState = 'consumed';
            await stagedLease?.release();
            return null;
        }
        entry.systemOpenLeaseCount += 1;
        let released = false;
        let retainedByLease = null;
        const finish = async (retained) => {
            if (!retained && this.entries.get(claim.sourceId) === entry) {
                entry.systemOpenClaimState = 'consumed';
            }
            await stagedLease.release();
            entry.systemOpenLeaseCount = Math.max(0, entry.systemOpenLeaseCount - 1);
            if (retained) {
                // A successful handoff owns the source independently of the renderer
                // release request.  Resolve that request without tearing down the
                // retained copy; expiry/sender teardown is the next owner.
                entry.systemOpenReleaseRequested = false;
                this.resolveDeferredSystemOpenRelease(entry, { ok: true, value: null });
                return;
            }
            if (entry.systemOpenLeaseCount !== 0 || !entry.systemOpenReleaseRequested) {
                return;
            }
            entry.systemOpenReleaseRequested = false;
            const result = this.entries.get(claim.sourceId) === entry && !entry.systemOpenRetained
                ? await this.releaseEntry(senderId, claim.sourceId, entry)
                : { ok: true, value: null };
            this.resolveDeferredSystemOpenRelease(entry, result);
        };
        return {
            path: stagedLease.path,
            validate: () => (released ? Promise.resolve(false) : validate()),
            retain: async () => {
                if (released)
                    return retainedByLease;
                released = true;
                // Revalidate immediately before transfer.  The staged copy can have
                // been replaced or deleted after acquireSystemOpenSource returned;
                // retaining in that state would keep the wrong copy alive while the
                // path handed to the shell is already retired.
                let refreshedClaim = null;
                try {
                    if (await validate()) {
                        refreshedClaim = this.retainSystemOpenSource(senderId, claim.sourceId, entry, claim.generation, stagedKind, stagedCopy, claim.nonce);
                    }
                }
                catch {
                    refreshedClaim = null;
                }
                await finish(refreshedClaim !== null);
                retainedByLease = refreshedClaim;
                return refreshedClaim;
            },
            release: async () => {
                if (released)
                    return;
                released = true;
                await finish(false);
            },
        };
    }
    issueSystemOpenClaim(senderId, sourceId, ownerToken) {
        // Retained entries are hidden from ordinary renderer authority APIs, but a
        // successful system-open handoff intentionally exposes one freshly rotated
        // claim so the UI can perform an explicit Reopen within the retention
        // window.  Never issue a claim for a release-requested or foreign entry.
        const entry = this.entries.get(sourceId);
        if (!entry ||
            entry.senderId !== senderId ||
            (ownerToken !== undefined && entry.ownerToken !== ownerToken) ||
            !entry.sessionId ||
            entry.systemOpenClaimState !== 'issued' ||
            entry.systemOpenReleaseRequested ||
            (entry.systemOpenRetained && !this.isLiveSystemOpenRetention(sourceId, senderId))) {
            return null;
        }
        return Object.freeze({
            kind: 'source',
            sourceId,
            sessionId: entry.sessionId,
            contentSha256: entry.source.contentSha256,
            generation: entry.generation,
            nonce: entry.systemOpenNonce,
        });
    }
    /**
     * Convert a trusted asset capability into a short-lived main-owned staged
     * source. The only path passed to the shell is the registry copy produced
     * from bytes read and hashed through a no-follow descriptor.
     */
    async acquireSystemOpenAsset(senderId, resolution, ownerToken) {
        if (typeof resolution.sessionId !== 'string' ||
            !SYSTEM_OPEN_OPAQUE_ID.test(resolution.sessionId) ||
            (ownerToken !== undefined && (typeof ownerToken !== 'object' || ownerToken === null))) {
            return null;
        }
        const claimKey = this.systemOpenAssetClaimKey(senderId, resolution.assetId, resolution.sessionId);
        if (this.systemOpenAssetClaims.has(claimKey))
            return null;
        const assetClaim = {
            senderId,
            assetId: resolution.assetId,
            sessionId: resolution.sessionId,
            ownerToken,
            state: 'in-flight',
        };
        this.systemOpenAssetClaims.set(claimKey, assetClaim);
        const releaseAssetClaim = () => {
            if (this.systemOpenAssetClaims.get(claimKey) === assetClaim) {
                this.systemOpenAssetClaims.delete(claimKey);
            }
        };
        const opened = await this.openLegacy(senderId, {
            assetId: resolution.assetId,
            sessionId: resolution.sessionId,
            assetResolution: resolution,
        }, ownerToken);
        if (!opened.ok) {
            releaseAssetClaim();
            return null;
        }
        const sourceId = opened.value.sourceId;
        let transferred = false;
        try {
            const read = await this.read(senderId, sourceId, MAX_INPUT_BYTES, ownerToken);
            if (!read.ok)
                return null;
            const staged = await this.cacheLegacyCopy(senderId, sourceId, read.value.bytes, ownerToken);
            if (!staged.ok)
                return null;
            const claim = this.issueSystemOpenClaim(senderId, sourceId, ownerToken);
            if (!claim)
                return null;
            const lease = await this.acquireSystemOpenSource(senderId, claim, ownerToken);
            if (!lease)
                return null;
            transferred = true;
            let released = false;
            let retainedByLease = null;
            return {
                path: lease.path,
                validate: () => (released ? Promise.resolve(false) : lease.validate()),
                retain: async () => {
                    if (released)
                        return retainedByLease;
                    released = true;
                    // `acquireSystemOpenSource` owns the staged-copy handoff.  Calling
                    // its retain operation first transfers ownership synchronously
                    // before the borrowed lease is released; releasing here and then
                    // publishing retention would leave a window in which renderer
                    // teardown can delete the copy after shell.openPath succeeds.
                    let refreshedClaim = null;
                    try {
                        refreshedClaim = await lease.retain();
                    }
                    finally {
                        // If the source lease went stale while the asset was being
                        // handed off, this wrapper must still release the source entry.
                        // Otherwise `transferred` ownership would leave an unreachable
                        // source behind because the wrapper is already marked released.
                        if (!refreshedClaim) {
                            await this.release(senderId, sourceId, ownerToken).catch(() => undefined);
                            releaseAssetClaim();
                        }
                    }
                    if (refreshedClaim && this.systemOpenAssetClaims.get(claimKey) === assetClaim) {
                        assetClaim.state = 'retained';
                        assetClaim.sourceId = sourceId;
                    }
                    retainedByLease = refreshedClaim;
                    return refreshedClaim;
                },
                release: async () => {
                    if (released)
                        return;
                    released = true;
                    await lease.release();
                    await this.release(senderId, sourceId, ownerToken).catch(() => undefined);
                    releaseAssetClaim();
                },
            };
        }
        finally {
            if (!transferred) {
                await this.release(senderId, sourceId, ownerToken).catch(() => undefined);
                releaseAssetClaim();
            }
        }
    }
    async cacheSanitizedCopy(senderId, sourceId, bytes, ownerToken) {
        return this.cacheStagedCopy(senderId, sourceId, bytes, 'sanitized', ownerToken);
    }
    /**
     * Copy an allowlisted legacy presentation into a main-owned temporary file.
     * The returned path is available only through an opaque main-process lease;
     * no renderer IPC response contains the path or the raw bytes.
     */
    async cacheLegacyCopy(senderId, sourceId, bytes, ownerToken) {
        return this.cacheStagedCopy(senderId, sourceId, bytes, 'legacy', ownerToken);
    }
    async cacheStagedCopy(senderId, sourceId, bytes, kind, ownerToken) {
        const entry = this.getOwnedEntry(senderId, sourceId, ownerToken);
        if (!entry)
            return failure('source_not_found', 'Document preview source was not found');
        // A PPTX is normally staged through the sanitized OOXML lane. When the
        // DOM renderer cannot consume it, the same already-authorized source may
        // use a main-owned native/QuickLook copy. Do not extend this route to the
        // other OOXML document types.
        const legacyCompatible = entry.sourceKind === 'legacy' ||
            (entry.sourceKind === 'ooxml' &&
                path.extname(entry.source.fileName).toLowerCase() === '.pptx');
        if ((kind === 'legacy' && !legacyCompatible) ||
            (kind === 'sanitized' && entry.sourceKind !== 'ooxml')) {
            return failure('invalid_request', 'Document preview source route is not compatible');
        }
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > this.maxSanitizedBytes) {
            return failure('resource_limit_exceeded', kind === 'legacy'
                ? 'Legacy document preview source exceeds the artifact limit'
                : 'Sanitized document preview source exceeds the artifact limit');
        }
        const stageReservation = this.reserveStage(senderId, sourceId, bytes.byteLength);
        if (!stageReservation) {
            return failure('resource_limit_exceeded', kind === 'legacy'
                ? 'Legacy document preview staging limit reached'
                : 'Sanitized document preview staging limit reached', true);
        }
        let stagePublished = false;
        // Own the bytes before any asynchronous filesystem work.  A caller that
        // mutates its Uint8Array after this method returns must not be able to
        // change the digest or the bytes consumed by the native process.
        const ownedBytes = new Uint8Array(bytes.byteLength);
        ownedBytes.set(bytes);
        const expectedGeneration = entry.generation;
        let tempPath = null;
        try {
            const tempRoot = await this.ensureTempRoot();
            const extension = path.extname(entry.source.fileName).slice(1).toLowerCase() || 'bin';
            tempPath = path.join(tempRoot, `${randomBytes(16).toString('hex')}.${extension}`);
            const handle = await open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
            try {
                await handle.writeFile(ownedBytes);
                await handle.chmod(0o600);
            }
            finally {
                await handle.close();
            }
            if (!this.pendingStages.has(stageReservation) ||
                this.entries.get(sourceId) !== entry ||
                entry.generation !== expectedGeneration) {
                const removed = await this.removeWithRetry(tempPath, false);
                return removed
                    ? failure('source_not_found', 'Document preview source was released during staging')
                    : failure('internal', 'Document preview source cleanup failed');
            }
            const previousCopy = kind === 'legacy' ? entry.legacyCopy : entry.sanitizedCopy;
            const nextGeneration = entry.generation + 1;
            const info = await lstat(tempPath, { bigint: true });
            if (!info.isFile() || info.isSymbolicLink()) {
                throw new Error('sanitized_copy_not_regular');
            }
            if (!this.pendingStages.has(stageReservation) ||
                this.entries.get(sourceId) !== entry ||
                entry.generation !== expectedGeneration) {
                const removed = await this.removeWithRetry(tempPath, false);
                return removed
                    ? failure('source_not_found', 'Document preview source was released during staging')
                    : failure('internal', 'Document preview source cleanup failed');
            }
            const identity = {
                dev: info.dev,
                ino: info.ino,
                size: Number(info.size),
                mode: Number(info.mode),
            };
            let copy;
            const handleValue = issueSanitizedSourceHandle({
                sourceId,
                generation: nextGeneration,
                contentSha256: entry.source.contentSha256,
                sanitizedSha256: `sha256:${createHash('sha256').update(ownedBytes).digest('hex')}`,
                fileName: entry.source.fileName,
                sizeBytes: ownedBytes.byteLength,
            }, tempPath, () => this.validateStagedCopy(sourceId, entry, copy));
            copy = {
                senderId,
                path: tempPath,
                identity,
                handle: handleValue,
                kind,
                generation: nextGeneration,
                leases: 0,
                retired: false,
                leaseWaiters: [],
            };
            entry.generation = nextGeneration;
            entry.systemOpenNonce = randomBytes(16).toString('hex');
            entry.systemOpenClaimState = 'issued';
            if (kind === 'legacy')
                entry.legacyCopy = copy;
            else
                entry.sanitizedCopy = copy;
            if (!this.promoteStage(stageReservation, copy)) {
                // The source may have been released between the final identity check
                // and publication.  Do not leave an uncharged staged file behind.
                if (kind === 'legacy')
                    delete entry.legacyCopy;
                else
                    delete entry.sanitizedCopy;
                const removed = await this.removeWithRetry(tempPath, false);
                return removed
                    ? failure('source_not_found', 'Document preview source was released during staging')
                    : failure('internal', 'Document preview source cleanup failed');
            }
            stagePublished = true;
            tempPath = null;
            if (previousCopy && !(await this.retireStagedCopy(previousCopy))) {
                return failure('internal', 'Document preview source cleanup failed');
            }
            return { ok: true, value: null };
        }
        catch {
            if (tempPath)
                await this.removeWithRetry(tempPath, false);
            return failure('internal', kind === 'legacy'
                ? 'Legacy document preview source could not be staged'
                : 'Sanitized document preview source could not be staged');
        }
        finally {
            if (!stagePublished)
                this.releaseStageReservation(stageReservation);
        }
    }
    resolveSanitizedCopy(senderId, sourceId) {
        const copy = this.getOwnedEntry(senderId, sourceId)?.sanitizedCopy;
        return copy && !copy.retired ? copy.path : null;
    }
    resolveLegacyCopy(senderId, sourceId) {
        const copy = this.getOwnedEntry(senderId, sourceId)?.legacyCopy;
        return copy && !copy.retired ? copy.path : null;
    }
    /**
     * Return the current source generation without exposing a path or bytes.
     * Callers use this as the compare value for cancellation cleanup; a
     * replacement copy advances the generation before it becomes visible.
     */
    getSourceGeneration(senderId, sourceId, ownerToken) {
        return this.getOwnedEntry(senderId, sourceId, ownerToken)?.generation ?? null;
    }
    /**
     * Retire a staged copy only when it is still the generation observed by the
     * caller. A cancelled request must not delete a newer copy published by a
     * concurrent request for the same source.
     */
    async deleteStagedCopyIfGeneration(senderId, sourceId, kind, generation, ownerToken) {
        const entry = this.getOwnedEntry(senderId, sourceId, ownerToken);
        if (!entry)
            return failure('source_not_found', 'Document preview source was not found');
        if (!Number.isSafeInteger(generation) || generation < 0) {
            return failure('invalid_request', 'Invalid document preview source generation');
        }
        const copy = kind === 'legacy' ? entry.legacyCopy : entry.sanitizedCopy;
        if (!copy || copy.retired || copy.generation !== generation) {
            // Idempotent compare-and-discard: the generation was already replaced or
            // retired, so there is no safe object for this caller to remove.
            return { ok: true, value: null };
        }
        return this.deleteStagedCopy(senderId, sourceId, kind, ownerToken);
    }
    acquireSanitizedCopy(senderId, sourceId, ownerToken) {
        return this.acquireStagedCopy(senderId, sourceId, 'sanitized', false, ownerToken);
    }
    acquireLegacyCopy(senderId, sourceId, ownerToken) {
        return this.acquireStagedCopy(senderId, sourceId, 'legacy', false, ownerToken);
    }
    acquireStagedCopy(senderId, sourceId, kind, allowRetained = false, ownerToken) {
        const entry = allowRetained
            ? (() => {
                const candidate = this.entries.get(sourceId);
                return candidate?.senderId === senderId &&
                    (ownerToken === undefined || candidate.ownerToken === ownerToken)
                    ? candidate
                    : null;
            })()
            : this.getOwnedEntry(senderId, sourceId, ownerToken);
        const copy = kind === 'legacy' ? entry?.legacyCopy : entry?.sanitizedCopy;
        if (!entry || !copy || copy.retired)
            return null;
        copy.leases += 1;
        let released = false;
        return {
            path: copy.path,
            handle: copy.handle,
            generation: copy.generation,
            validate: () => this.validateStagedCopy(sourceId, entry, copy),
            release: async () => {
                if (released)
                    return { ok: true, value: null };
                released = true;
                copy.leases = Math.max(0, copy.leases - 1);
                if (copy.leases === 0) {
                    for (const resolve of copy.leaseWaiters.splice(0))
                        resolve();
                }
                if (copy.retired && copy.cleanupPromise && !(await copy.cleanupPromise)) {
                    return failure('internal', 'Document preview source cleanup failed');
                }
                return { ok: true, value: null };
            },
        };
    }
    isSanitizedCopyLive(senderId, sourceId, generation, ownerToken) {
        const copy = this.getOwnedEntry(senderId, sourceId, ownerToken)?.sanitizedCopy;
        return Boolean(copy && !copy.retired && copy.generation === generation);
    }
    isLegacyCopyLive(senderId, sourceId, generation, ownerToken) {
        const copy = this.getOwnedEntry(senderId, sourceId, ownerToken)?.legacyCopy;
        return Boolean(copy && !copy.retired && copy.generation === generation);
    }
    async deleteSanitizedCopy(senderId, sourceId, ownerToken) {
        return this.deleteStagedCopy(senderId, sourceId, 'sanitized', ownerToken);
    }
    async deleteLegacyCopy(senderId, sourceId, ownerToken) {
        return this.deleteStagedCopy(senderId, sourceId, 'legacy', ownerToken);
    }
    async deleteStagedCopy(senderId, sourceId, kind, ownerToken) {
        const entry = this.getOwnedEntry(senderId, sourceId, ownerToken);
        if (!entry)
            return failure('source_not_found', 'Document preview source was not found');
        this.releasePendingStagesFor((reservation) => reservation.senderId === senderId && reservation.sourceId === sourceId);
        const copy = kind === 'legacy' ? entry.legacyCopy : entry.sanitizedCopy;
        entry.generation += 1;
        entry.systemOpenNonce = randomBytes(16).toString('hex');
        entry.systemOpenClaimState = 'consumed';
        if (kind === 'legacy')
            delete entry.legacyCopy;
        else
            delete entry.sanitizedCopy;
        if (copy && !(await this.retireStagedCopy(copy))) {
            return failure('internal', 'Document preview source cleanup failed');
        }
        return { ok: true, value: null };
    }
    async release(senderId, sourceId, ownerToken) {
        const entry = this.entries.get(sourceId);
        if (!entry ||
            entry.senderId !== senderId ||
            (ownerToken !== undefined && entry.ownerToken !== ownerToken)) {
            return failure('source_not_found', 'Document preview source was not found');
        }
        // A successful system-open transfers ownership to the bounded retention
        // window. Renderer cleanup is still expected and must be idempotent, but
        // it must not delete the path before the shell has consumed it.
        if (entry.systemOpenRetained) {
            return { ok: true, value: null };
        }
        if (entry.systemOpenLeaseCount > 0) {
            // Keep the entry and its generation available to the in-flight lease so
            // a later retain() can atomically transfer ownership.  The release is
            // completed by that lease instead of deleting the staged copy early.
            entry.systemOpenReleaseRequested = true;
            return this.deferSystemOpenRelease(entry);
        }
        return this.releaseEntry(senderId, sourceId, entry);
    }
    deferSystemOpenRelease(entry) {
        if (entry.systemOpenReleasePromise)
            return entry.systemOpenReleasePromise;
        entry.systemOpenReleasePromise = new Promise((resolve) => {
            entry.systemOpenReleaseResolve = resolve;
        });
        return entry.systemOpenReleasePromise;
    }
    resolveDeferredSystemOpenRelease(entry, result) {
        const resolve = entry.systemOpenReleaseResolve;
        entry.systemOpenReleaseResolve = undefined;
        entry.systemOpenReleasePromise = undefined;
        resolve?.(result);
    }
    async releaseEntry(senderId, sourceId, entry) {
        this.removeSystemOpenRetention(sourceId);
        this.releasePendingStagesFor((reservation) => reservation.senderId === senderId && reservation.sourceId === sourceId);
        entry.generation += 1;
        entry.systemOpenNonce = randomBytes(16).toString('hex');
        entry.systemOpenClaimState = 'consumed';
        this.entries.delete(sourceId);
        const copies = [entry.sanitizedCopy, entry.legacyCopy].filter((copy) => Boolean(copy));
        if (!(await Promise.all(copies.map((copy) => this.retireStagedCopy(copy)))).every(Boolean)) {
            return failure('internal', 'Document preview source cleanup failed');
        }
        return { ok: true, value: null };
    }
    async releaseSender(senderId, ownerToken) {
        for (const [claimKey, claim] of this.systemOpenAssetClaims) {
            if (claim.senderId === senderId &&
                (ownerToken === undefined || claim.ownerToken === ownerToken)) {
                this.systemOpenAssetClaims.delete(claimKey);
            }
        }
        for (const [sourceId, retention] of this.systemOpenRetentions) {
            const entry = this.entries.get(sourceId);
            if (retention.senderId === senderId &&
                (ownerToken === undefined || entry?.ownerToken === ownerToken)) {
                this.systemOpenRetentions.delete(sourceId);
            }
        }
        this.scheduleSystemOpenRetentionExpiry();
        for (const [token, reservation] of this.pendingSources) {
            if (reservation.senderId === senderId &&
                (ownerToken === undefined || reservation.ownerToken === ownerToken)) {
                this.pendingSources.delete(token);
            }
        }
        const ownedSourceIds = new Set([...this.entries]
            .filter(([, entry]) => entry.senderId === senderId &&
            (ownerToken === undefined || entry.ownerToken === ownerToken))
            .map(([sourceId]) => sourceId));
        this.releasePendingStagesFor((reservation) => reservation.senderId === senderId &&
            (ownerToken === undefined || ownedSourceIds.has(reservation.sourceId)));
        const copies = [];
        for (const [sourceId, entry] of this.entries) {
            if (entry.senderId !== senderId ||
                (ownerToken !== undefined && entry.ownerToken !== ownerToken)) {
                continue;
            }
            entry.systemOpenReleaseRequested = false;
            this.resolveDeferredSystemOpenRelease(entry, { ok: true, value: null });
            entry.systemOpenRetained = false;
            entry.generation += 1;
            entry.systemOpenNonce = randomBytes(16).toString('hex');
            entry.systemOpenClaimState = 'consumed';
            if (entry.sanitizedCopy)
                copies.push(entry.sanitizedCopy);
            if (entry.legacyCopy)
                copies.push(entry.legacyCopy);
            this.entries.delete(sourceId);
        }
        const removed = await Promise.all(copies.map((copy) => this.retireStagedCopy(copy)));
        return removed.every(Boolean)
            ? { ok: true, value: null }
            : failure('internal', 'Document preview source cleanup failed');
    }
    async releaseAll() {
        this.systemOpenAssetClaims.clear();
        this.systemOpenRetentions.clear();
        if (this.systemOpenRetentionTimer)
            clearTimeout(this.systemOpenRetentionTimer);
        this.systemOpenRetentionTimer = null;
        this.pendingSources.clear();
        this.releasePendingStagesFor(() => true);
        const copies = [];
        for (const entry of this.entries.values()) {
            entry.systemOpenReleaseRequested = false;
            this.resolveDeferredSystemOpenRelease(entry, { ok: true, value: null });
            entry.systemOpenRetained = false;
            entry.generation += 1;
            entry.systemOpenNonce = randomBytes(16).toString('hex');
            entry.systemOpenClaimState = 'consumed';
            if (entry.sanitizedCopy)
                copies.push(entry.sanitizedCopy);
            if (entry.legacyCopy)
                copies.push(entry.legacyCopy);
        }
        this.entries.clear();
        const copyResults = await Promise.all(copies.map((copy) => this.retireStagedCopy(copy)));
        const pendingResults = await Promise.all([...this.pendingDeletes].map(([target, recursive]) => this.removeWithRetry(target, recursive)));
        if (![...copyResults, ...pendingResults].every(Boolean)) {
            return failure('internal', 'Document preview source cleanup failed');
        }
        if (this.tempRootPromise) {
            try {
                const tempRoot = await this.tempRootPromise;
                if (!(await this.removeWithRetry(tempRoot, true))) {
                    return failure('internal', 'Document preview source cleanup failed');
                }
                this.tempRootPromise = null;
            }
            catch {
                return failure('internal', 'Document preview source cleanup failed');
            }
        }
        return { ok: true, value: null };
    }
    resolveForBackend(senderId, sourceId, ownerToken) {
        const entry = this.getOwnedEntry(senderId, sourceId, ownerToken);
        if (!entry)
            return null;
        return { senderId: entry.senderId, source: entry.source };
    }
    countSenderSources(senderId) {
        let count = 0;
        for (const entry of this.entries.values())
            if (entry.senderId === senderId)
                count += 1;
        return count;
    }
    reserveSource(senderId, ownerToken) {
        let senderCount = 0;
        for (const entry of this.entries.values()) {
            if (entry.senderId === senderId)
                senderCount += 1;
        }
        for (const reservation of this.pendingSources.values()) {
            if (reservation.senderId === senderId)
                senderCount += 1;
        }
        if (this.entries.size + this.pendingSources.size >= this.maxSources ||
            senderCount >= this.maxSourcesPerSender) {
            return null;
        }
        const token = randomBytes(16).toString('hex');
        this.pendingSources.set(token, { senderId, ownerToken });
        return token;
    }
    reserveStage(senderId, sourceId, byteLength) {
        let senderPendingCount = 0;
        for (const reservation of this.pendingStages.values()) {
            if (reservation.senderId === senderId)
                senderPendingCount += 1;
        }
        let senderStagedBytes = this.stagedBytesBySender.get(senderId) ?? 0;
        const senderPendingBytes = this.pendingStagedBytesBySender.get(senderId) ?? 0;
        senderStagedBytes += senderPendingBytes;
        if (this.pendingStages.size >= this.maxPendingStaging ||
            senderPendingCount >= this.maxPendingStagingPerSender ||
            this.stagedBytes + this.pendingStagedBytes + byteLength > this.maxStagedBytes ||
            senderStagedBytes + byteLength > this.maxStagedBytesPerSender) {
            return null;
        }
        const token = randomBytes(16).toString('hex');
        this.pendingStages.set(token, { senderId, sourceId, byteLength });
        this.pendingStagedBytes += byteLength;
        this.adjustSenderBytes(this.pendingStagedBytesBySender, senderId, byteLength);
        return token;
    }
    promoteStage(token, copy) {
        const reservation = this.pendingStages.get(token);
        if (!reservation)
            return false;
        this.pendingStages.delete(token);
        this.pendingStagedBytes -= reservation.byteLength;
        this.adjustSenderBytes(this.pendingStagedBytesBySender, reservation.senderId, -reservation.byteLength);
        this.stagedCopiesByPath.set(copy.path, copy);
        this.stagedBytes += copy.handle.sizeBytes;
        this.adjustSenderBytes(this.stagedBytesBySender, reservation.senderId, copy.handle.sizeBytes);
        return true;
    }
    releaseStageReservation(token) {
        const reservation = this.pendingStages.get(token);
        if (!reservation)
            return;
        this.pendingStages.delete(token);
        this.pendingStagedBytes = Math.max(0, this.pendingStagedBytes - reservation.byteLength);
        this.adjustSenderBytes(this.pendingStagedBytesBySender, reservation.senderId, -reservation.byteLength);
    }
    releasePendingStagesFor(predicate) {
        for (const [token, reservation] of this.pendingStages) {
            if (predicate(reservation))
                this.releaseStageReservation(token);
        }
    }
    adjustSenderBytes(map, senderId, delta) {
        const next = (map.get(senderId) ?? 0) + delta;
        if (next <= 0)
            map.delete(senderId);
        else
            map.set(senderId, next);
    }
    releaseStagedCopyCharge(copy) {
        if (!this.stagedCopiesByPath.delete(copy.path))
            return;
        this.stagedBytes = Math.max(0, this.stagedBytes - copy.handle.sizeBytes);
        this.adjustSenderBytes(this.stagedBytesBySender, copy.senderId, -copy.handle.sizeBytes);
    }
    getOwnedEntry(senderId, sourceId, ownerToken) {
        if (typeof sourceId !== 'string')
            return null;
        const entry = this.entries.get(sourceId);
        return entry?.senderId === senderId &&
            (ownerToken === undefined || entry.ownerToken === ownerToken) &&
            !entry.systemOpenRetained &&
            !entry.systemOpenReleaseRequested
            ? entry
            : null;
    }
    retainSystemOpenSource(senderId, sourceId, candidate, expectedGeneration, expectedKind, expectedCopy, expectedNonce) {
        const entry = candidate ?? this.getOwnedEntry(senderId, sourceId);
        const currentCopy = expectedKind === 'legacy'
            ? entry?.legacyCopy
            : expectedKind === 'sanitized'
                ? entry?.sanitizedCopy
                : undefined;
        if (!entry ||
            entry.senderId !== senderId ||
            !entry.sessionId ||
            this.entries.get(sourceId) !== entry ||
            expectedGeneration === undefined ||
            entry.generation !== expectedGeneration ||
            !expectedCopy ||
            expectedNonce === undefined ||
            entry.systemOpenNonce !== expectedNonce ||
            entry.systemOpenClaimState !== 'in-flight' ||
            expectedCopy.retired ||
            expectedCopy.generation !== expectedGeneration ||
            currentCopy !== expectedCopy ||
            (entry.systemOpenRetained && !this.isLiveSystemOpenRetention(sourceId, senderId)) ||
            this.stagedCopiesByPath.get(expectedCopy.path) !== expectedCopy) {
            return null;
        }
        // Invalidate the renderer-held claim before publishing the retention
        // owner. Normal source/read/stage lookups reject retained entries; only
        // this gesture-gated system-open lease can redeem the rotated claim.
        entry.systemOpenRetained = true;
        entry.systemOpenReleaseRequested = false;
        // The source/copy generation identifies the immutable staged artifact and
        // therefore remains stable across Reopen.  The per-handoff nonce is the
        // one-shot capability epoch; rotating it invalidates the claim just used
        // while keeping the retained copy redeemable until expiry.
        entry.systemOpenNonce = randomBytes(16).toString('hex');
        entry.systemOpenClaimState = 'issued';
        this.systemOpenRetentions.set(sourceId, {
            senderId,
            expiresAtMs: Date.now() + this.systemOpenRetentionMs,
        });
        this.scheduleSystemOpenRetentionExpiry();
        return Object.freeze({
            kind: 'source',
            sourceId,
            sessionId: entry.sessionId,
            contentSha256: entry.source.contentSha256,
            generation: entry.generation,
            nonce: entry.systemOpenNonce,
        });
    }
    removeSystemOpenRetention(sourceId) {
        if (!this.systemOpenRetentions.delete(sourceId))
            return;
        this.scheduleSystemOpenRetentionExpiry();
    }
    /**
     * An asset handoff is represented by a temporary source while the staged
     * copy is retained. Once that source is gone, its asset claim can neither
     * be redeemed nor protect any live resource, so it must not keep blocking a
     * future user-gesture handoff for the same asset.
     */
    releaseSystemOpenAssetClaimsForSource(senderId, sourceId) {
        for (const [claimKey, claim] of this.systemOpenAssetClaims) {
            if (claim.senderId === senderId && claim.sourceId === sourceId) {
                this.systemOpenAssetClaims.delete(claimKey);
            }
        }
    }
    systemOpenAssetClaimKey(senderId, assetId, sessionId) {
        return `${senderId}\u0000${sessionId}\u0000${assetId}`;
    }
    isLiveSystemOpenRetention(sourceId, senderId) {
        const retention = this.systemOpenRetentions.get(sourceId);
        return Boolean(retention && retention.senderId === senderId && retention.expiresAtMs > Date.now());
    }
    scheduleSystemOpenRetentionExpiry() {
        if (this.systemOpenRetentionTimer)
            clearTimeout(this.systemOpenRetentionTimer);
        this.systemOpenRetentionTimer = null;
        let nextExpiry = Number.POSITIVE_INFINITY;
        for (const retention of this.systemOpenRetentions.values()) {
            nextExpiry = Math.min(nextExpiry, retention.expiresAtMs);
        }
        if (!Number.isFinite(nextExpiry))
            return;
        this.systemOpenRetentionTimer = setTimeout(() => {
            this.systemOpenRetentionTimer = null;
            void this.expireSystemOpenRetentions();
        }, Math.max(0, nextExpiry - Date.now()));
        this.systemOpenRetentionTimer.unref?.();
    }
    async expireSystemOpenRetentions(nowMs = Date.now()) {
        const expired = [];
        for (const [sourceId, retention] of this.systemOpenRetentions) {
            if (retention.expiresAtMs > nowMs)
                continue;
            const entry = this.entries.get(sourceId);
            // An in-flight Reopen has already redeemed the current claim and owns a
            // staged-copy lease.  Deleting the entry while that lease is validating
            // would make a successful shell handoff appear to fail and could race
            // the lease's retain() call.  Give the active handoff one bounded window
            // to finish; releaseSender/releaseAll still revoke it immediately.
            if (entry?.senderId === retention.senderId && entry.systemOpenLeaseCount > 0) {
                retention.expiresAtMs = nowMs + this.systemOpenRetentionMs;
                continue;
            }
            this.systemOpenRetentions.delete(sourceId);
            expired.push({ senderId: retention.senderId, sourceId });
        }
        this.scheduleSystemOpenRetentionExpiry();
        await Promise.all(expired.map(({ senderId, sourceId }) => this.releaseRetainedSource(senderId, sourceId).then(() => undefined, () => undefined)));
    }
    async releaseRetainedSource(senderId, sourceId) {
        this.releaseSystemOpenAssetClaimsForSource(senderId, sourceId);
        const entry = this.entries.get(sourceId);
        if (!entry || entry.senderId !== senderId) {
            return { ok: true, value: null };
        }
        entry.systemOpenRetained = false;
        return this.releaseEntry(senderId, sourceId, entry);
    }
    async validateStagedCopy(sourceId, entry, copy) {
        if (copy.retired ||
            this.entries.get(sourceId) !== entry ||
            entry.generation !== copy.generation ||
            (copy.kind === 'legacy' ? entry.legacyCopy : entry.sanitizedCopy) !== copy) {
            return false;
        }
        try {
            const info = await lstat(copy.path, { bigint: true });
            if (!info.isFile() || info.isSymbolicLink())
                return false;
            if (info.dev !== copy.identity.dev ||
                info.ino !== copy.identity.ino ||
                Number(info.size) !== copy.identity.size ||
                Number(info.size) !== copy.handle.sizeBytes) {
                return false;
            }
            if (process.platform !== 'win32' && (Number(info.mode) & 0o777) !== 0o600)
                return false;
            const handle = await open(copy.path, openFlags());
            try {
                const hashed = await hashAndReadHandle(handle, false, SANITIZED_STAGE_MAX_BYTES);
                return (hashed !== null &&
                    hashed.fingerprint.size === copy.handle.sizeBytes &&
                    `sha256:${hashed.fingerprint.sha256}` === copy.handle.sanitizedSha256);
            }
            finally {
                await handle.close().catch(() => undefined);
            }
        }
        catch {
            return false;
        }
    }
    async ensureTempRoot() {
        if (!this.tempRootPromise) {
            this.tempRootPromise = (async () => {
                await mkdir(tmpdir(), { recursive: true });
                const root = await mkdtemp(path.join(tmpdir(), 'mavis-office-preview-'));
                await chmod(root, 0o700).catch(() => undefined);
                return root;
            })();
        }
        return this.tempRootPromise;
    }
    retireStagedCopy(copy) {
        if (copy.cleanupPromise)
            return copy.cleanupPromise;
        copy.retired = true;
        copy.cleanupPromise = (async () => {
            if (copy.leases > 0) {
                // Retiring revokes the handle immediately. If an untrusted backend
                // never releases its borrowed descriptor, unlink/isolate the staged
                // pathname after a bounded grace period instead of blocking Electron
                // shutdown forever (open descriptors remain OS-owned until closed).
                await this.waitForLeaseDrain(copy);
            }
            return this.removeWithRetry(copy.path, false);
        })();
        return copy.cleanupPromise;
    }
    waitForLeaseDrain(copy) {
        return new Promise((resolve) => {
            const timer = setTimeout(resolve, this.leaseDrainTimeoutMs);
            copy.leaseWaiters.push(() => {
                clearTimeout(timer);
                resolve();
            });
        });
    }
    async removeWithRetry(target, recursive) {
        if (!this.pendingDeletes.has(target) && this.pendingDeletes.size >= this.maxPendingDeletes) {
            return false;
        }
        this.pendingDeletes.set(target, recursive);
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                await this.removePath(target, recursive);
                this.pendingDeletes.delete(target);
                if (recursive) {
                    for (const [copyPath, copy] of this.stagedCopiesByPath) {
                        if (isContained(target, copyPath))
                            this.releaseStagedCopyCharge(copy);
                    }
                }
                else {
                    const copy = this.stagedCopiesByPath.get(target);
                    if (copy)
                        this.releaseStagedCopyCharge(copy);
                }
                return true;
            }
            catch {
                if (attempt < 2 && this.cleanupRetryDelayMs > 0) {
                    await new Promise((resolve) => setTimeout(resolve, this.cleanupRetryDelayMs));
                }
            }
        }
        return false;
    }
}

