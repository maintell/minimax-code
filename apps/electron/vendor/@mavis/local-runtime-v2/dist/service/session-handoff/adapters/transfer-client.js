import { readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { SessionHandoffError } from '../errors.js';
const MAX_NATIVE_OUTPUT_BYTES = 64 << 10;
const TRANSFER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
export class NativeHandoffTransferClient {
    options;
    runNative;
    activeTransfers = new Set();
    constructor(options) {
        this.options = options;
        this.runNative = options.runNative ?? runNativeTransfer;
    }
    async run(input) {
        const sourceRevisionId = validateTransferInput(input);
        const dataDirectory = this.transferDirectory(input.ticket.transferId);
        this.activeTransfers.add(input.ticket.transferId);
        try {
            const auth = this.options.cloud.createTransferAuth();
            await this.runNative({
                binaryPath: this.options.binaryPath,
                ...(auth.refreshHeaders ? { refreshHeaders: auth.refreshHeaders } : {}),
                ...(input.onProgress ? { onProgress: input.onProgress } : {}),
                config: {
                    direction: input.direction,
                    local_path: input.localPath,
                    remote_root: '/',
                    data_directory: dataDirectory,
                    source_revision_id: sourceRevisionId,
                    ...(input.direction === 'upload' && input.snapshot
                        ? {
                            manifest_hash: input.snapshot.manifestHash,
                            files: input.snapshot.files.map((file) => ({
                                relative_path: file.relativePath,
                                sha256: file.sha256,
                                size_bytes: file.sizeBytes,
                                sensitive: file.sensitive === true,
                            })),
                        }
                        : {}),
                    relay: {
                        endpoint_url: this.options.cloud.resolveTransferEndpoint(input.ticket.endpointUrl),
                        access_token: input.ticket.accessToken,
                        headers: auth.headers,
                        ...(auth.refreshHeaders ? { auth_refresh: true } : {}),
                    },
                },
            });
        }
        finally {
            this.activeTransfers.delete(input.ticket.transferId);
        }
    }
    async cleanup(ticket) {
        if (!TRANSFER_ID_PATTERN.test(ticket.transferId)) {
            throw transferError('Transfer identity is invalid');
        }
        if (this.activeTransfers.has(ticket.transferId))
            return;
        await removeTransferState(this.transferDirectory(ticket.transferId));
    }
    async cleanupOrphans(retainedTransferIds) {
        const root = this.transferDirectory('');
        const retained = new Set([...retainedTransferIds, ...this.activeTransfers]);
        let entries;
        try {
            entries = await readdir(root, { withFileTypes: true });
        }
        catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
                return;
            throw error;
        }
        for (const entry of entries) {
            if (retained.has(entry.name) || this.activeTransfers.has(entry.name))
                continue;
            await removeTransferState(join(root, entry.name));
        }
    }
    transferDirectory(transferId) {
        return join(this.options.dataDir, 'v2', 'session-handoff', 'object-transfer', transferId);
    }
}
function validateTransferInput(input) {
    if (!TRANSFER_ID_PATTERN.test(input.ticket.transferId)) {
        throw transferError('Transfer identity is invalid');
    }
    if (!input.ticket.sourceRevisionId) {
        throw transferError('Approved transfer source revision is missing');
    }
    if (input.direction === 'upload' && !input.snapshot) {
        throw transferError('Approved transfer snapshot is missing');
    }
    return input.ticket.sourceRevisionId;
}
async function removeTransferState(dataDirectory) {
    try {
        await rm(dataDirectory, { recursive: true, force: true });
    }
    catch {
        // Cleanup must not replace an authoritative transfer result.
    }
}
const runNativeTransfer = async (input) => {
    const child = spawn(input.binaryPath, [], {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
        env: {},
    });
    let pending = Buffer.alloc(0);
    let outputBytes = 0;
    let result;
    let closed = false;
    let generation = 0;
    let refreshing = false;
    let authRecovery;
    let failure;
    let latestProgress;
    let pendingProgress;
    let progressDelivery;
    const fail = (error) => {
        failure ??= error;
        if (!closed)
            child.kill();
    };
    const writeHeaders = async () => {
        refreshing = true;
        try {
            const headers = await input.refreshHeaders?.();
            if (closed || failure)
                return;
            generation += 1;
            child.stdin.write(`${JSON.stringify({ type: 'auth_headers', generation, headers })}\n`);
        }
        catch (error) {
            // 错误可能包含宿主凭据；不向 UI 或原生进程透传原始内容。
            const retryable = !(error instanceof SessionHandoffError) || error.retryable;
            fail(transferError('Native transfer authentication could not be refreshed', retryable));
        }
        finally {
            refreshing = false;
        }
    };
    const refreshAuth = (requestedGeneration) => {
        if (closed ||
            !input.refreshHeaders ||
            refreshing ||
            result ||
            requestedGeneration !== generation) {
            throw transferError('Native transfer authentication request is invalid');
        }
        authRecovery = writeHeaders();
    };
    const deliverProgress = async () => {
        try {
            while (pendingProgress) {
                const progress = pendingProgress;
                pendingProgress = undefined;
                try {
                    await input.onProgress?.(progress);
                }
                catch {
                    // Progress is advisory; its persistence cannot invalidate confirmed OSS parts.
                }
            }
        }
        finally {
            progressDelivery = undefined;
        }
    };
    const reportProgress = (uploaded, total) => {
        const progress = parseNativeProgress(uploaded, total);
        if (result ||
            (latestProgress &&
                (progress.totalBytes !== latestProgress.totalBytes ||
                    progress.uploadedBytes < latestProgress.uploadedBytes)))
            throw transferError('Native transfer progress is invalid');
        latestProgress = progress;
        pendingProgress = progress;
        progressDelivery ??= deliverProgress();
    };
    const consumeLine = (line) => {
        if (failure)
            return;
        try {
            const message = parseNativeMessage(line);
            if (message.type === 'refresh_auth') {
                refreshAuth(message.generation);
            }
            else if (message.type === 'progress') {
                reportProgress(message.uploaded_bytes, message.total_bytes);
            }
            else {
                if (message.type !== undefined || refreshing || result) {
                    throw transferError('Native transfer response is invalid');
                }
                result = parseNativeResult(message);
            }
        }
        catch (error) {
            fail(error instanceof SessionHandoffError
                ? error
                : transferError('Native transfer response is invalid'));
        }
    };
    let exitCode;
    try {
        exitCode = await new Promise((resolve, reject) => {
            child.once('error', fail);
            child.stdin.once('error', fail);
            child.stdout.once('error', fail);
            child.stdout.on('data', (chunk) => {
                outputBytes += chunk.byteLength;
                if (outputBytes > MAX_NATIVE_OUTPUT_BYTES) {
                    fail(transferError('Native transfer response exceeded its limit'));
                    return;
                }
                pending = Buffer.concat([pending, chunk]);
                let newline;
                while ((newline = pending.indexOf('\n')) !== -1) {
                    const line = pending.subarray(0, newline).toString('utf8');
                    pending = pending.subarray(newline + 1);
                    consumeLine(line);
                }
            });
            child.once('close', (code, signal) => {
                closed = true;
                if (pending.length > 0)
                    consumeLine(pending.toString('utf8'));
                if (failure)
                    reject(failure);
                else if (signal !== null)
                    reject(transferError('Native transfer process was interrupted', true));
                else
                    resolve(code ?? 1);
            });
            const configLine = `${JSON.stringify(input.config)}\n`;
            if (input.refreshHeaders)
                child.stdin.write(configLine);
            else
                child.stdin.end(configLine);
        });
    }
    finally {
        await progressDelivery;
    }
    if (!result)
        throw transferError('Native transfer response is invalid', exitCode !== 0);
    if (exitCode !== 0 || !result.success) {
        throw transferError('Native session transfer failed', result.retryable);
    }
    if (authRecovery)
        await authRecovery;
};
function parseNativeProgress(uploadedBytes, totalBytes) {
    if (typeof uploadedBytes !== 'number' ||
        typeof totalBytes !== 'number' ||
        !Number.isSafeInteger(uploadedBytes) ||
        !Number.isSafeInteger(totalBytes) ||
        uploadedBytes < 0 ||
        totalBytes < 0 ||
        uploadedBytes > totalBytes) {
        throw transferError('Native transfer progress is invalid');
    }
    return { uploadedBytes, totalBytes };
}
function parseNativeResult(message) {
    if (typeof message.success !== 'boolean' ||
        (message.retryable !== undefined && typeof message.retryable !== 'boolean') ||
        (message.success && message.retryable === true)) {
        throw transferError('Native transfer response is invalid');
    }
    return { success: message.success, retryable: message.retryable === true };
}
function parseNativeMessage(raw) {
    const value = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw transferError('Native transfer response is invalid');
    }
    return value;
}
function transferError(message, retryable = false) {
    return new SessionHandoffError('HANDOFF_UNAVAILABLE', message, retryable);
}
//# sourceMappingURL=transfer-client.js.map