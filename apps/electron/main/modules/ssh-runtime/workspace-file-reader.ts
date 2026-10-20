import { posix } from "node:path";
import { sshProjectIdFromRuntimeId, sshProjectRuntimeId } from "@mavis/shared/desktop-runtime";
import { isSafeAbsoluteRemotePath } from "./config";
const WORKSPACE_FILE_CONTENT_PATH = '/minimax-desktop/api/v1/file/content';
/**
 * One remote read per stream pull. Kept small on purpose: an SSH Runtime shares
 * a single bandwidth-capped link with every interactive request, so a large
 * chunk holds the wire long enough to stall file-tree and editor reads behind
 * it. One MiB bounds that head-of-line delay to well under a second on a slow
 * link while still amortising the per-request protocol overhead.
 */
const MEDIA_READ_CHUNK_BYTES = 1024 * 1024;
/** Owns read leases, file projection and stream cancellation; borrows the host transport. */
export class SshWorkspaceFileReader {
    constructor(options) {
        this.options = options;
    }
    /**
     * Fetch one browser media request through the Runtime owned by an SSH
     * project. Absolute references can belong to another persisted project on
     * the same host; the renderer cannot introduce a new host or workspace root.
     */
    async fetchMedia(runtimeId, request) {
        const release = this.options.retainOperation(runtimeId);
        const onAbort = () => release();
        request.signal.addEventListener('abort', onAbort, { once: true });
        const finish = () => {
            request.signal.removeEventListener('abort', onAbort);
            release();
        };
        try {
            request.signal.throwIfAborted();
            const response = await this.fetchMediaWithConnection(runtimeId, request);
            if (!response.body) {
                finish();
                return response;
            }
            return retainMediaResponse(response, finish, request.signal);
        }
        catch (error) {
            finish();
            throw error;
        }
    }
    async fetchMediaWithConnection(runtimeId, request) {
        if (typeof runtimeId !== 'string')
            return mediaError(400, 'invalid_runtime_id');
        const projectId = sshProjectIdFromRuntimeId(runtimeId);
        if (!projectId)
            return mediaError(400, 'invalid_runtime_id');
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            return mediaError(405, 'method_not_allowed');
        }
        const target = this.options.repository.getRuntimeTarget(projectId);
        if (!target)
            return mediaError(404, 'project_not_found');
        const url = new URL(request.url);
        const location = this.resolveMediaLocation(target, url.searchParams.get('workspace'), url.searchParams.get('path'));
        if (url.pathname !== '/mavis/api/file/media' || !location) {
            return mediaError(403, 'workspace_scope_mismatch');
        }
        const { workspace, path } = location;
        const manager = await this.options.resolveConnection(runtimeId);
        if (!manager)
            return mediaError(503, 'project_runtime_unavailable');
        const rangeHeader = request.headers.get('range');
        const rangeHint = parseRangeStartHint(rangeHeader);
        if (rangeHint === 'invalid')
            return unsatisfiedRange();
        const initialOffset = rangeHint ?? 0;
        const initialLength = requestedInitialLength(rangeHeader);
        const initialResult = await readRemoteFileChunk(manager, workspace, path, initialOffset, initialLength, request.signal);
        if (initialResult instanceof Response)
            return initialResult;
        // A pre-range Runtime ignores offset/length and returns the complete file.
        // Preserve compatibility by slicing that response locally. Upgrading the
        // remote CLI enables the actual lazy Range path below.
        if (initialResult.sizeBytes === undefined || initialResult.truncated === undefined) {
            return legacyMediaResponse(initialResult, path, rangeHeader, request.method === 'HEAD');
        }
        const sizeBytes = initialResult.sizeBytes;
        const resolvedRange = resolveByteRange(rangeHeader, sizeBytes);
        if (resolvedRange === 'invalid')
            return unsatisfiedRange(sizeBytes);
        let firstChunk = initialResult;
        if (resolvedRange.start !== initialOffset) {
            const firstResult = await readRemoteFileChunk(manager, workspace, path, resolvedRange.start, Math.min(MEDIA_READ_CHUNK_BYTES, resolvedRange.end - resolvedRange.start + 1), request.signal);
            if (firstResult instanceof Response)
                return firstResult;
            firstChunk = firstResult;
        }
        if (firstChunk.sizeBytes !== sizeBytes ||
            firstChunk.revision !== initialResult.revision ||
            firstChunk.bytes.byteLength > resolvedRange.end - resolvedRange.start + 1) {
            return mediaError(409, 'remote_file_changed');
        }
        const contentLength = sizeBytes === 0 ? 0 : resolvedRange.end - resolvedRange.start + 1;
        const headers = mediaHeaders(path, firstChunk.mimeType, sizeBytes, resolvedRange);
        if (request.method === 'HEAD' || contentLength === 0) {
            return new Response(null, {
                status: resolvedRange.partial ? 206 : 200,
                headers,
            });
        }
        return new Response(createRemoteMediaStream({
            manager,
            workspace,
            path,
            firstChunk,
            range: resolvedRange,
            sizeBytes,
            signal: request.signal,
        }), {
            status: resolvedRange.partial ? 206 : 200,
            headers,
        });
    }
    resolveMediaLocation(source, workspace, path) {
        if (!workspace ||
            !isSafeAbsoluteRemotePath(workspace) ||
            !path ||
            posix.isAbsolute(path) ||
            /[\u0000-\u001f\u007f]/u.test(path) ||
            path.split('/').includes('..'))
            return null;
        // SSH paths are POSIX paths, even when Desktop itself runs on Windows.
        // Preserve the exact requested file: never try an alternative basename.
        const absolutePath = posix.join(workspace, path);
        const candidates = [
            source,
            ...this.options.repository.list().flatMap((project) => {
                const target = this.options.repository.getRuntimeTarget(project.id);
                return target?.host === source.host ? [target] : [];
            }),
        ].sort((left, right) => right.workspaceDir.length - left.workspaceDir.length);
        for (const target of candidates) {
            const relativePath = posix.relative(target.workspaceDir, absolutePath);
            if (!relativePath || relativePath === '..' || relativePath.startsWith('../'))
                continue;
            // Runtime still performs physical-path containment and Unix permission
            // checks. A rejected symlink must not fall back to a broader project.
            return { workspace: target.workspaceDir, path: relativePath };
        }
        return null;
    }
    /**
     * Read one complete workspace file from the SSH project that owns
     * `workspaceDir`, for a consumer that needs a local copy rather than a
     * stream (document preview staging, QuickLook, LibreOffice).
     *
     * The workspace is matched against persisted project state, so a caller
     * cannot use this to reach a path outside a project it already owns.
     * `maxBytes` bounds the transfer: a remote file larger than the caller's
     * budget fails instead of being silently truncated.
     */
    async readWorkspaceFileBytes(runtimeId, workspaceDir, relativePath, options) {
        const release = this.options.retainOperation(runtimeId);
        try {
            return await this.readWorkspaceFileWithConnection(runtimeId, workspaceDir, relativePath, options);
        }
        finally {
            release();
        }
    }
    async readWorkspaceFileWithConnection(runtimeId, workspaceDir, relativePath, options) {
        if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)
            return null;
        const projectId = this.projectIdForWorkspace(runtimeId, workspaceDir);
        if (!projectId)
            return null;
        const manager = await this.options.resolveConnection(sshProjectRuntimeId(projectId));
        if (!manager)
            return null;
        const signal = options.signal ?? new AbortController().signal;
        const chunks = [];
        let offset = 0;
        let revision;
        let mimeType;
        let sizeBytes;
        for (;;) {
            if (signal.aborted)
                return null;
            const chunk = await readRemoteFileChunk(manager, workspaceDir, relativePath, offset, Math.min(MEDIA_READ_CHUNK_BYTES, options.maxBytes - offset + 1), signal);
            if (signal.aborted || chunk instanceof Response)
                return null;
            if (offset === 0) {
                revision = chunk.revision;
                mimeType = chunk.mimeType;
                sizeBytes = chunk.sizeBytes;
                if (chunk.sizeBytes !== undefined && chunk.sizeBytes > options.maxBytes)
                    return null;
            }
            else if (chunk.revision !== revision || chunk.sizeBytes !== sizeBytes) {
                // The remote file changed mid-transfer; a spliced copy would be worse
                // than no preview at all.
                return null;
            }
            if (chunk.bytes.byteLength > 0) {
                chunks.push(chunk.bytes);
                offset += chunk.bytes.byteLength;
            }
            if (offset > options.maxBytes)
                return null;
            // A pre-range Runtime returns the whole file and reports neither field.
            if (chunk.sizeBytes === undefined || chunk.truncated === undefined)
                break;
            if (offset > chunk.sizeBytes)
                return null;
            if (offset === chunk.sizeBytes)
                break;
            // An empty/terminal chunk before the declared end is a failed transfer,
            // never a valid partial document to hand to a local previewer.
            if (chunk.bytes.byteLength === 0 || !chunk.truncated)
                return null;
        }
        const total = chunks.reduce((sum, part) => sum + part.byteLength, 0);
        const bytes = new Uint8Array(total);
        let written = 0;
        for (const part of chunks) {
            bytes.set(part, written);
            written += part.byteLength;
        }
        return {
            bytes,
            ...(mimeType ? { mimeType } : {}),
            ...(revision ? { revision } : {}),
        };
    }
    /** The runtime identity selects the host; the path only validates its workspace. */
    projectIdForWorkspace(runtimeId, workspaceDir) {
        const projectId = sshProjectIdFromRuntimeId(runtimeId);
        if (!projectId || !workspaceDir)
            return null;
        const target = this.options.repository.getRuntimeTarget(projectId);
        return target?.workspaceDir === workspaceDir ? projectId : null;
    }
}

/** Release a Main read lease only at EOF/cancel; never replay a failed stream. */
function retainMediaResponse(response, release, signal) {
    const reader = response.body.getReader();
    let done = false;
    const finish = () => {
        if (done)
            return;
        done = true;
        signal.removeEventListener('abort', onAbort);
        release();
    };
    const onAbort = () => {
        void reader.cancel(signal.reason).catch(() => undefined);
        finish();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted)
        onAbort();
    const body = new ReadableStream({
        async pull(controller) {
            try {
                signal.throwIfAborted();
                const part = await reader.read();
                signal.throwIfAborted();
                if (part.done) {
                    controller.close();
                    finish();
                }
                else
                    controller.enqueue(part.value);
            }
            catch (error) {
                controller.error(error);
                finish();
            }
        },
        async cancel(reason) {
            try {
                await reader.cancel(reason);
            }
            finally {
                finish();
            }
        },
    });
    return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    });
}
function mediaError(status, error) {
    return new Response(JSON.stringify({ error }), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}
async function readRemoteFileChunk(manager, workspace, path, offset, length, signal) {
    const url = new URL(WORKSPACE_FILE_CONTENT_PATH, 'http://project-runtime.local');
    url.searchParams.set('workspace', workspace);
    url.searchParams.set('path', path);
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('length', String(length));
    url.searchParams.set('raw', 'true');
    const response = await manager.fetch(new Request(url, { method: 'GET', signal }));
    if (!response.ok)
        return response;
    let payload;
    try {
        payload = await response.json();
    }
    catch {
        return mediaError(502, 'invalid_remote_file_response');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return mediaError(502, 'invalid_remote_file_response');
    }
    const record = payload;
    if (record.encoding !== 'base64' || typeof record.content !== 'string') {
        return mediaError(502, 'invalid_remote_file_response');
    }
    let bytes;
    try {
        bytes = Uint8Array.from(Buffer.from(record.content, 'base64'));
    }
    catch {
        return mediaError(502, 'invalid_remote_file_response');
    }
    const sizeBytes = optionalSafeInteger(record.size_bytes);
    const truncated = typeof record.truncated === 'boolean' ? record.truncated : undefined;
    const revision = typeof record.revision === 'string' ? record.revision : undefined;
    const mimeType = typeof record.mime_type === 'string' ? record.mime_type : undefined;
    return {
        bytes,
        type: record.type === 'binary' ? 'binary' : 'text',
        ...(mimeType ? { mimeType } : {}),
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        ...(truncated !== undefined ? { truncated } : {}),
        ...(revision ? { revision } : {}),
    };
}
function createRemoteMediaStream(options) {
    let pendingChunk = options.firstChunk;
    let nextOffset = options.range.start;
    let cancelled = false;
    const abortController = new AbortController();
    const signal = AbortSignal.any([options.signal, abortController.signal]);
    return new ReadableStream({
        async pull(controller) {
            if (cancelled || signal.aborted) {
                controller.close();
                return;
            }
            let chunk = pendingChunk;
            pendingChunk = null;
            if (!chunk) {
                const remaining = options.range.end - nextOffset + 1;
                if (remaining <= 0) {
                    controller.close();
                    return;
                }
                const result = await readRemoteFileChunk(options.manager, options.workspace, options.path, nextOffset, Math.min(MEDIA_READ_CHUNK_BYTES, remaining), signal);
                // Some transports can finish despite cancellation. Never enqueue a
                // late response into a closed preview or start another chunk for it.
                if (cancelled)
                    return;
                signal.throwIfAborted();
                if (result instanceof Response) {
                    controller.error(new Error(`Remote media read failed with status ${result.status}`));
                    return;
                }
                chunk = result;
            }
            if (chunk.sizeBytes !== options.sizeBytes ||
                chunk.revision !== options.firstChunk.revision ||
                chunk.bytes.byteLength === 0) {
                controller.error(new Error('Remote file changed while streaming'));
                return;
            }
            const remaining = options.range.end - nextOffset + 1;
            const bytes = chunk.bytes.byteLength > remaining ? chunk.bytes.slice(0, remaining) : chunk.bytes;
            nextOffset += bytes.byteLength;
            controller.enqueue(bytes);
            if (nextOffset > options.range.end)
                controller.close();
        },
        cancel() {
            cancelled = true;
            abortController.abort();
        },
    });
}
function legacyMediaResponse(chunk, path, rangeHeader, head) {
    const sizeBytes = chunk.bytes.byteLength;
    const range = resolveByteRange(rangeHeader, sizeBytes);
    if (range === 'invalid')
        return unsatisfiedRange(sizeBytes);
    const bytes = chunk.bytes.slice(range.start, range.end + 1);
    return new Response(head ? null : bytes, {
        status: range.partial ? 206 : 200,
        headers: mediaHeaders(path, chunk.mimeType, sizeBytes, range),
    });
}
function mediaHeaders(path, mimeType, sizeBytes, range) {
    const contentLength = sizeBytes === 0 ? 0 : range.end - range.start + 1;
    const headers = new Headers({
        'Accept-Ranges': 'bytes',
        'Content-Length': String(contentLength),
        'Content-Type': mimeType ?? inferMediaMimeType(path),
        'Cache-Control': 'no-store',
    });
    if (range.partial) {
        headers.set('Content-Range', `bytes ${range.start}-${range.end}/${sizeBytes}`);
    }
    return headers;
}
function parseRangeStartHint(header) {
    if (!header)
        return null;
    const match = /^bytes=(\d+)-(\d*)$/u.exec(header.trim());
    if (match) {
        const start = Number(match[1]);
        return Number.isSafeInteger(start) ? start : 'invalid';
    }
    if (/^bytes=-\d+$/u.test(header.trim()))
        return null;
    return 'invalid';
}
function requestedInitialLength(header) {
    if (!header)
        return MEDIA_READ_CHUNK_BYTES;
    const match = /^bytes=(\d+)-(\d+)$/u.exec(header.trim());
    if (!match)
        return MEDIA_READ_CHUNK_BYTES;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) {
        return MEDIA_READ_CHUNK_BYTES;
    }
    return Math.min(MEDIA_READ_CHUNK_BYTES, end - start + 1);
}
/**
 * Resolve a browser `Range` header against the authoritative remote size.
 *
 * Honor an open-ended request through EOF. Chromium's app:// media loader may
 * not request another window after a shortened response, leaving tail metadata
 * unreadable. Remote reads remain bounded by MEDIA_READ_CHUNK_BYTES and cancel
 * with the consumer; the response range is not the transport chunk size.
 */
function resolveByteRange(header, sizeBytes) {
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0)
        return 'invalid';
    if (!header) {
        return { start: 0, end: Math.max(0, sizeBytes - 1), partial: false };
    }
    if (sizeBytes === 0)
        return 'invalid';
    const normalized = header.trim();
    const absolute = /^bytes=(\d+)-(\d*)$/u.exec(normalized);
    if (absolute) {
        const start = Number(absolute[1]);
        const openEnded = !absolute[2];
        const requestedEnd = openEnded ? sizeBytes - 1 : Number(absolute[2]);
        if (!Number.isSafeInteger(start) ||
            !Number.isSafeInteger(requestedEnd) ||
            start >= sizeBytes ||
            requestedEnd < start) {
            return 'invalid';
        }
        const end = Math.min(requestedEnd, sizeBytes - 1);
        return { start, end, partial: true };
    }
    const suffix = /^bytes=-(\d+)$/u.exec(normalized);
    if (!suffix)
        return 'invalid';
    const length = Number(suffix[1]);
    if (!Number.isSafeInteger(length) || length <= 0)
        return 'invalid';
    return { start: Math.max(0, sizeBytes - length), end: sizeBytes - 1, partial: true };
}
function unsatisfiedRange(sizeBytes) {
    const headers = new Headers({ 'Accept-Ranges': 'bytes' });
    if (sizeBytes !== undefined)
        headers.set('Content-Range', `bytes */${sizeBytes}`);
    return new Response(null, { status: 416, headers });
}
function optionalSafeInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function inferMediaMimeType(path) {
    const extension = path.split('.').at(-1)?.toLowerCase();
    switch (extension) {
        case 'mp4':
        case 'm4v':
            return 'video/mp4';
        case 'webm':
            return 'video/webm';
        case 'mov':
            return 'video/quicktime';
        case 'mp3':
            return 'audio/mpeg';
        case 'wav':
            return 'audio/wav';
        case 'm4a':
            return 'audio/mp4';
        case 'ogg':
        case 'oga':
            return 'audio/ogg';
        default:
            return 'application/octet-stream';
    }
}
