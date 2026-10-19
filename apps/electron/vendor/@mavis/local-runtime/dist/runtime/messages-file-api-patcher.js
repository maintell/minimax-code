/**
 * Messages File API payload patcher for local-runtime.
 *
 * Functional twin: packages/cloud-runtime/src/host/pi-session/messages-file-api-patcher.ts.
 * Keep upload, cache-key, traversal, and fail-open behavior aligned in both copies.
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { logger } from '../common/logger.js';
class FileApiUploadError extends Error {
    status;
    apiStatusCode;
    constructor(message, status, apiStatusCode) {
        super(message);
        this.status = status;
        this.apiStatusCode = apiStatusCode;
        this.name = 'FileApiUploadError';
    }
}
export function buildFileApiUploadCacheKey(input) {
    return `${input.contentHash}:${input.endpointHash}:${input.callerIdentityHash}:${input.ttlSec}`;
}
export function buildMessagesFileApiPatcher(options) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const nowMs = options.nowMs ?? Date.now;
    const ttlSec = Number.isFinite(options.ttlSec) && options.ttlSec >= 0 ? options.ttlSec : 43_200;
    const uploadTimeoutMs = typeof options.uploadTimeoutMs === 'number' &&
        Number.isFinite(options.uploadTimeoutMs) &&
        options.uploadTimeoutMs > 0
        ? options.uploadTimeoutMs
        : 60_000;
    const inFlight = new Map();
    const endpointHash = sha256(options.uploadEndpoint);
    const endpointForLog = redactEndpointForLog(options.uploadEndpoint);
    return async function patchMessagesFileApiBlocks(payload, model) {
        if (options.signal?.aborted)
            return undefined;
        if (model.api !== 'anthropic-messages' || !isMessagesPayload(payload))
            return undefined;
        const targets = collectMediaTargets(payload.messages);
        if (targets.length === 0)
            return undefined;
        let mutated = false;
        let convertedCount = 0;
        await Promise.all(targets.map(async (target) => {
            const fileId = await resolveFileId(target);
            if (!fileId)
                return;
            target.block.source = { type: 'url', url: `${options.refScheme}${fileId}` };
            mutated = true;
            convertedCount += 1;
        }));
        const videoMimeFallbackCount = targets.filter((target) => target.videoMimeFallback).length;
        const skippedCount = targets.length - convertedCount;
        if (videoMimeFallbackCount > 0 || skippedCount > 0) {
            logger.info({
                candidate_count: targets.length,
                converted_count: convertedCount,
                skipped_count: skippedCount,
                video_mime_fallback_count: videoMimeFallbackCount,
            }, '[messages-file-api] final payload media conversion summary');
        }
        return mutated ? payload : undefined;
    };
    async function resolveFileId(target) {
        const recordKey = {
            contentHash: hashMediaIdentity(target),
            endpointHash,
            callerIdentityHash: options.callerIdentityHash,
            ttlSec,
        };
        const cacheKey = buildFileApiUploadCacheKey(recordKey);
        let cached;
        try {
            cached = await options.store.get(cacheKey, recordKey);
        }
        catch (error) {
            if (options.signal?.aborted)
                return undefined;
            logger.warn({
                upload_endpoint: endpointForLog,
                block_index: target.blockIndex,
                error_type: error instanceof Error ? error.name : typeof error,
            }, '[messages-file-api] cache lookup failed; uploading without a cached reference');
        }
        if (cached && cached.expiresAtMs > nowMs())
            return cached.fileId;
        let pending = inFlight.get(cacheKey);
        if (!pending) {
            pending = uploadAndRemember({
                options,
                fetchImpl,
                nowMs,
                ttlSec,
                uploadTimeoutMs,
                cacheKey,
                recordKey,
                target,
                signal: options.signal,
            });
            inFlight.set(cacheKey, pending);
            pending.then(() => {
                if (inFlight.get(cacheKey) === pending)
                    inFlight.delete(cacheKey);
            }, () => {
                if (inFlight.get(cacheKey) === pending)
                    inFlight.delete(cacheKey);
            });
        }
        try {
            return await pending;
        }
        catch (error) {
            if (options.signal?.aborted)
                return undefined;
            logger.warn({
                upload_endpoint: endpointForLog,
                block_index: target.blockIndex,
                ...(error instanceof FileApiUploadError && error.status !== undefined
                    ? { status: error.status }
                    : {}),
                ...(error instanceof FileApiUploadError && error.apiStatusCode !== undefined
                    ? { api_status_code: error.apiStatusCode }
                    : {}),
                error_type: error instanceof Error ? error.name : typeof error,
            }, '[messages-file-api] upload failed; keeping inline media block');
            return undefined;
        }
    }
}
async function uploadAndRemember(input) {
    const fileId = await uploadMedia(input.fetchImpl, input.options.uploadEndpoint, input.options.gatewayHeaders, input.target, input.uploadTimeoutMs, input.signal);
    const expiresAtMs = input.nowMs() + input.ttlSec * 1_000;
    const entry = { fileId, expiresAtMs };
    try {
        await input.options.store.set(input.cacheKey, entry, { ...input.recordKey, ...entry });
    }
    catch (error) {
        logger.warn({
            upload_endpoint: redactEndpointForLog(input.options.uploadEndpoint),
            block_index: input.target.blockIndex,
            error_type: error instanceof Error ? error.name : typeof error,
        }, '[messages-file-api] cache persistence failed after upload; continuing with file reference');
    }
    return fileId;
}
async function uploadMedia(fetchImpl, endpoint, gatewayHeaders, target, timeoutMs, signal) {
    const form = new FormData();
    const bytes = Buffer.from(target.source.data, 'base64');
    const file = new Blob([bytes], { type: target.source.media_type });
    form.append('purpose', target.purpose);
    form.append('file', file, filenameForMediaType(target.source.media_type));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abortForTurn = () => controller.abort(signal?.reason);
    if (signal?.aborted) {
        abortForTurn();
    }
    else {
        signal?.addEventListener('abort', abortForTurn, { once: true });
    }
    try {
        const response = await fetchImpl(endpoint, {
            method: 'POST',
            headers: gatewayHeaders,
            body: form,
            signal: controller.signal,
        });
        if (!response.ok)
            throw new FileApiUploadError('upload returned non-2xx', response.status);
        const body = (await response.json());
        const fileId = readSuccessfulFileId(body);
        if (!fileId)
            throw new FileApiUploadError('upload response missing successful file_id', response.status, readFileApiStatusCode(body));
        return fileId;
    }
    finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortForTurn);
    }
}
function readFileApiStatusCode(value) {
    if (!isRecord(value) || !isRecord(value.base_resp))
        return undefined;
    const statusCode = value.base_resp.status_code;
    return typeof statusCode === 'number' || typeof statusCode === 'string' ? statusCode : undefined;
}
function readSuccessfulFileId(value) {
    if (!isRecord(value))
        return undefined;
    const baseResp = value.base_resp;
    const file = value.file;
    if (!isRecord(baseResp) || baseResp.status_code !== 0 || !isRecord(file))
        return undefined;
    const fileId = file.file_id;
    if (typeof fileId === 'number') {
        return Number.isSafeInteger(fileId) && fileId >= 0 ? String(fileId) : undefined;
    }
    return typeof fileId === 'string' && fileId.trim() ? fileId.trim() : undefined;
}
function redactEndpointForLog(value) {
    try {
        const endpoint = new URL(value);
        endpoint.username = '';
        endpoint.password = '';
        endpoint.search = '';
        endpoint.hash = '';
        return endpoint.toString();
    }
    catch {
        return '[invalid gateway endpoint]';
    }
}
function collectMediaTargets(messages) {
    const targets = [];
    const visited = new WeakSet();
    let blockIndex = 0;
    const visitContent = (value) => {
        if (!value || typeof value !== 'object' || visited.has(value))
            return;
        visited.add(value);
        if (Array.isArray(value)) {
            for (const item of value)
                visitContent(item);
            return;
        }
        if (!isRecord(value))
            return;
        const currentIndex = blockIndex++;
        const source = readBase64MediaSource(value.source);
        const purpose = mediaPurpose(value.type, source?.media_type);
        if (source && purpose) {
            targets.push({
                block: value,
                source,
                blockIndex: currentIndex,
                purpose,
                videoMimeFallback: value.type === 'image' && purpose === 'video_understanding',
            });
        }
        if (Array.isArray(value.content))
            visitContent(value.content);
    };
    for (const message of messages) {
        if (message && Array.isArray(message.content))
            visitContent(message.content);
    }
    return targets;
}
function mediaPurpose(blockType, mediaType) {
    const normalized = mediaType?.trim().toLowerCase();
    if (blockType === 'image' && normalized?.startsWith('image/'))
        return 'image_understanding';
    if ((blockType === 'image' || blockType === 'video') && normalized?.startsWith('video/')) {
        return 'video_understanding';
    }
    return undefined;
}
function readBase64MediaSource(value) {
    if (!isRecord(value))
        return undefined;
    return value.type === 'base64' &&
        typeof value.media_type === 'string' &&
        typeof value.data === 'string'
        ? { type: 'base64', media_type: value.media_type, data: value.data }
        : undefined;
}
function filenameForMediaType(mediaType) {
    const subtype = mediaType.split('/')[1]?.toLowerCase() ?? '';
    const extension = subtype === 'jpeg'
        ? 'jpg'
        : subtype === 'quicktime'
            ? 'mov'
            : subtype === 'x-msvideo'
                ? 'avi'
                : /^[a-z0-9]+$/u.test(subtype)
                    ? subtype
                    : 'bin';
    return `mavis-media.${extension}`;
}
function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}
function hashMediaIdentity(target) {
    return createHash('sha256')
        .update(target.purpose)
        .update('\0')
        .update(target.source.media_type.trim().toLowerCase())
        .update('\0')
        .update(target.source.data)
        .digest('hex');
}
function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
function isMessagesPayload(payload) {
    return isRecord(payload) && Array.isArray(payload.messages);
}
//# sourceMappingURL=messages-file-api-patcher.js.map