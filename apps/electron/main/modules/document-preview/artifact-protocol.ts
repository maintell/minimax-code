import { constants } from "node:fs";
import { lstat, realpath, open } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { PREVIEW_ARTIFACT_SCHEME_V1, PREVIEW_ARTIFACT_HOST_V1 } from "@mavis/shared/document-preview";
import { noopDocumentPreviewLogger, describeDocumentPreviewError } from "./logging";
const ARTIFACT_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/u;
const PDF_PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/u;
const PDF_MIME_TYPES = {
    '.css': 'text/css; charset=utf-8',
    '.ftl': 'text/plain; charset=utf-8',
    '.gif': 'image/gif',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.properties': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ttf': 'font/ttf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
};
const STATIC_SECURITY_HEADERS = {
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self' blob: data:; font-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'self'",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
};
const VIEWER_FRAME_ANCESTORS = [
    "'self'",
    'app://*',
    'http://localhost:*',
    'http://127.0.0.1:*',
];
function staticSecurityHeaders(isViewer, extraFrameAncestors = []) {
    if (!isViewer)
        return { ...STATIC_SECURITY_HEADERS };
    const frameAncestors = [
        ...VIEWER_FRAME_ANCESTORS,
        ...extraFrameAncestors.filter((origin) => origin.length > 0 &&
            origin !== '*' &&
            !origin.includes(';') &&
            !origin.includes("'") &&
            /^(?:app:\/\/\*|https?:\/\/localhost(?::\*)?|https?:\/\/127\.0\.0\.1(?::\*)?)$/u.test(origin)),
    ];
    return {
        ...STATIC_SECURITY_HEADERS,
        'Content-Security-Policy': STATIC_SECURITY_HEADERS['Content-Security-Policy'].replace("frame-ancestors 'self'", `frame-ancestors ${[...new Set(frameAncestors)].join(' ')}`),
    };
}
const noopDocumentPreviewArtifactGuardHitReporter = () => undefined;
function notFound() {
    return new Response(null, { status: 404 });
}
function methodNotAllowed() {
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
}
function liveArtifactPreviewId(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    }
    catch {
        return null;
    }
    if (url.protocol !== PREVIEW_ARTIFACT_SCHEME_V1 ||
        url.hostname !== PREVIEW_ARTIFACT_HOST_V1 ||
        url.port ||
        url.username ||
        url.password ||
        url.search ||
        url.hash) {
        return null;
    }
    const segments = url.pathname.split('/');
    if (segments.length !== 4 ||
        segments[0] !== '' ||
        segments[1] !== 'artifact' ||
        !ARTIFACT_SEGMENT.test(segments[2] ?? '') ||
        !ARTIFACT_SEGMENT.test(segments[3] ?? '')) {
        return null;
    }
    return segments[2];
}
/**
 * Builds the default-Session request guard for live artifact capabilities.
 *
 * `protocol.handle()` receives a standard Request with no trustworthy
 * WebContents identity. `session.webRequest`, by contrast, supplies the
 * browser-owned `webContentsId`; only that value is compared with the lease
 * owner. Renderer headers, referrers, and query parameters never grant access.
 */
export function createDocumentPreviewArtifactRequestGuard(options) {
    const logger = options.logger ?? noopDocumentPreviewLogger;
    const onGuardHit = options.onGuardHit ?? noopDocumentPreviewArtifactGuardHitReporter;
    /**
     * Runs only after the webRequest decision has been handed back, and never
     * propagates: a telemetry sink that throws must not be able to strand a
     * request or turn diagnostics into transport control.
     */
    const reportGuardHit = (kind, previewId) => {
        try {
            onGuardHit(kind, { previewId });
        }
        catch (error) {
            logger.warn({
                msg: '[DocumentPreview][artifact-protocol] guard telemetry sink failed',
                previewId,
                kind,
                ...describeDocumentPreviewError(error),
            });
        }
    };
    return (details, callback) => {
        const previewId = liveArtifactPreviewId(details.url);
        if (!previewId) {
            callback({});
            return;
        }
        let ownerId;
        try {
            ownerId = options.store.getLeaseOwnerSenderId(previewId);
        }
        catch (error) {
            callback({ cancel: true });
            logger.warn({
                msg: '[DocumentPreview][artifact-protocol] lease owner lookup failed; cancelling request',
                previewId,
                ...describeDocumentPreviewError(error),
            });
            reportGuardHit('lease_owner_lookup_failed', previewId);
            return;
        }
        if (ownerId === null) {
            // Let the protocol handler produce the stable released/missing result.
            callback({});
            return;
        }
        if (!Number.isSafeInteger(ownerId) ||
            ownerId < 0 ||
            !Number.isSafeInteger(details.webContentsId) ||
            details.webContentsId !== ownerId) {
            callback({ cancel: true });
            logger.warn({
                msg: '[DocumentPreview][artifact-protocol] artifact request rejected: webContents does not own the lease',
                previewId,
                ownerId,
                requestWebContentsId: details.webContentsId ?? null,
            });
            reportGuardHit('lease_owner_mismatch', previewId);
            return;
        }
        callback({});
    };
}
function isContained(root, candidate) {
    const relative = path.relative(root, candidate);
    return (relative === '' ||
        (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)));
}
function decodePathSegments(pathname) {
    const rawSegments = pathname.split('/');
    if (rawSegments.some((segment) => segment === '' && rawSegments.length > 1)) {
        // A leading slash is expected; empty interior segments are not needed by
        // PDF.js and make URL canonicalisation unnecessarily ambiguous.
        if (rawSegments.some((segment, index) => index > 0 && segment === ''))
            return null;
    }
    const segments = [];
    for (const raw of rawSegments.slice(1)) {
        let decoded;
        try {
            decoded = decodeURIComponent(raw);
        }
        catch {
            return null;
        }
        if (!decoded ||
            decoded.includes('/') ||
            decoded.includes('\\') ||
            decoded === '.' ||
            decoded === '..' ||
            !PDF_PATH_SEGMENT.test(decoded)) {
            return null;
        }
        segments.push(decoded);
    }
    return segments;
}
async function resolveStaticFile(pdfRoots, pathname) {
    if (!pathname.startsWith('/pdf/'))
        return null;
    const relative = pathname.slice('/pdf/'.length);
    const segments = decodePathSegments(`/${relative}`);
    if (!segments || segments.length === 0)
        return null;
    for (const configuredRoot of pdfRoots) {
        if (!configuredRoot)
            continue;
        let root;
        try {
            const rootInfo = await lstat(configuredRoot, { bigint: true });
            if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
                continue;
            root = await realpath(configuredRoot);
        }
        catch {
            continue;
        }
        const candidates = [path.join(root, ...segments), path.join(root, 'pdf', ...segments)];
        for (const candidate of candidates) {
            let handle = null;
            try {
                // Resolve containment before opening, then walk every lexical
                // component with lstat.  A symlink alias inside the static tree is
                // rejected even when it points back inside the root.
                const canonical = await realpath(candidate);
                if (!isContained(root, canonical))
                    continue;
                const lexicalRelative = path.relative(root, candidate);
                let current = root;
                let valid = true;
                for (const component of lexicalRelative.split(path.sep).filter(Boolean)) {
                    current = path.join(current, component);
                    const info = await lstat(current, { bigint: true });
                    if (info.isSymbolicLink()) {
                        valid = false;
                        break;
                    }
                }
                if (!valid)
                    continue;
                const info = await lstat(candidate, { bigint: true });
                if (!info.isFile() || info.isSymbolicLink())
                    continue;
                handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
                const opened = await handle.stat({ bigint: true });
                if (!opened.isFile() ||
                    opened.isSymbolicLink() ||
                    opened.dev !== info.dev ||
                    opened.ino !== info.ino ||
                    opened.size !== info.size) {
                    await handle.close().catch(() => undefined);
                    handle = null;
                    continue;
                }
                const afterOpen = await lstat(candidate, { bigint: true });
                if (afterOpen.isSymbolicLink() ||
                    afterOpen.dev !== opened.dev ||
                    afterOpen.ino !== opened.ino ||
                    afterOpen.size !== opened.size) {
                    await handle.close().catch(() => undefined);
                    handle = null;
                    continue;
                }
                return { handle, canonicalPath: canonical, size: Number(opened.size) };
            }
            catch {
                await handle?.close().catch(() => undefined);
                // Try the next root/candidate.
            }
        }
    }
    return null;
}
export function parseRange(raw, size) {
    if (!raw)
        return null;
    if (size <= 0 || !raw.startsWith('bytes='))
        return 'invalid';
    const ranges = raw.slice('bytes='.length).split(',');
    if (ranges.length !== 1)
        return 'invalid';
    const value = ranges[0]?.trim() ?? '';
    const separator = value.indexOf('-');
    if (separator < 0)
        return 'invalid';
    const startText = value.slice(0, separator).trim();
    const endText = value.slice(separator + 1).trim();
    if (!startText && !endText)
        return 'invalid';
    let start;
    let end;
    if (!startText) {
        const suffix = Number.parseInt(endText, 10);
        if (!Number.isSafeInteger(suffix) || suffix <= 0)
            return 'invalid';
        start = Math.max(0, size - suffix);
        end = size - 1;
    }
    else {
        start = Number.parseInt(startText, 10);
        if (!Number.isSafeInteger(start) || start < 0 || start >= size)
            return 'invalid';
        if (!endText)
            end = size - 1;
        else {
            end = Number.parseInt(endText, 10);
            if (!Number.isSafeInteger(end) || end < start)
                return 'invalid';
            end = Math.min(end, size - 1);
        }
    }
    return { start, end };
}
function streamBody(handle, range) {
    // Keep the validated no-follow descriptor as the stream's source of truth.
    // FileHandle.createReadStream owns that descriptor and auto-closes it on
    // normal completion, errors, and consumer cancellation. Do not call
    // handle.close() from a second listener: a late async close could race a
    // subsequent request that reuses the same numeric descriptor.
    const stream = handle.createReadStream({
        autoClose: true,
        ...(range ? { start: range.start, end: range.end } : {}),
    });
    return Readable.toWeb(stream);
}
async function serveArtifact(request, options, pathname) {
    const logger = options.logger ?? noopDocumentPreviewLogger;
    const segments = pathname.split('/');
    if (segments.length !== 4 ||
        segments[0] !== '' ||
        segments[1] !== 'artifact' ||
        !ARTIFACT_SEGMENT.test(segments[2] ?? '') ||
        !ARTIFACT_SEGMENT.test(segments[3] ?? '')) {
        return notFound();
    }
    const previewId = segments[2];
    const resourceId = segments[3];
    const resource = options.store.resolveLeaseResource(previewId, resourceId);
    if (!resource) {
        // A lease that has expired or been released is routine renderer churn.
        logger.info({
            msg: '[DocumentPreview][artifact-protocol] artifact lease not found or expired',
            previewId,
            resourceId,
        });
        return notFound();
    }
    let actualSize;
    let handle = null;
    try {
        // Validate and stream from the same no-follow descriptor.  A pathname
        // stat followed by createReadStream leaves a symlink/rename TOCTOU window.
        const info = await lstat(resource.absolutePath, { bigint: true });
        if (!info.isFile() || info.isSymbolicLink() || info.size !== BigInt(resource.sizeBytes)) {
            logger.warn({
                msg: '[DocumentPreview][artifact-protocol] artifact rejected before open (symlink/size/type guard)',
                previewId,
                resourceId,
            });
            return notFound();
        }
        handle = await open(resource.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const opened = await handle.stat({ bigint: true });
        const afterOpen = await lstat(resource.absolutePath, { bigint: true });
        if (!opened.isFile() ||
            opened.size !== BigInt(resource.sizeBytes) ||
            opened.dev !== info.dev ||
            opened.ino !== info.ino ||
            afterOpen.isSymbolicLink() ||
            afterOpen.dev !== opened.dev ||
            afterOpen.ino !== opened.ino ||
            afterOpen.size !== opened.size ||
            (resource.fileIdentity !== undefined &&
                (String(opened.dev) !== resource.fileIdentity.dev ||
                    String(opened.ino) !== resource.fileIdentity.ino ||
                    Number(opened.size) !== resource.fileIdentity.size ||
                    String(opened.mtimeNs) !== resource.fileIdentity.mtimeNs ||
                    String(opened.ctimeNs) !== resource.fileIdentity.ctimeNs))) {
            await handle.close().catch(() => undefined);
            handle = null;
            logger.warn({
                msg: '[DocumentPreview][artifact-protocol] artifact rejected by post-open identity/TOCTOU guard',
                previewId,
                resourceId,
            });
            return notFound();
        }
        actualSize = Number(info.size);
    }
    catch (error) {
        await handle?.close().catch(() => undefined);
        logger.warn({
            msg: '[DocumentPreview][artifact-protocol] artifact IO error while validating descriptor',
            previewId,
            resourceId,
            ...describeDocumentPreviewError(error),
        });
        return notFound();
    }
    const parsedRange = parseRange(request.headers.get('range'), actualSize);
    if (parsedRange === 'invalid') {
        await handle?.close().catch(() => undefined);
        return new Response(null, {
            status: 416,
            headers: {
                'Content-Range': `bytes */${actualSize}`,
                'Accept-Ranges': 'bytes',
            },
        });
    }
    const range = parsedRange ?? undefined;
    const length = range ? range.end - range.start + 1 : actualSize;
    const headers = new Headers({
        'Content-Type': resource.mediaType,
        'Content-Length': String(length),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Content-Disposition': `inline; filename="${resource.name.replace(/"/gu, '')}"`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'self'; object-src 'none'; img-src 'self' data: blob:; font-src 'self'",
        'Cross-Origin-Resource-Policy': 'same-origin',
    });
    if (range)
        headers.set('Content-Range', `bytes ${range.start}-${range.end}/${actualSize}`);
    if (request.method === 'HEAD') {
        await handle?.close().catch(() => undefined);
        return new Response(null, { status: range ? 206 : 200, headers });
    }
    if (!handle)
        return notFound();
    try {
        // `streamBody` is a Node-backed Web stream. Keep the runtime stream
        // untouched while using the Node Response constructor's own body type.
        return new Response(streamBody(handle, range), {
            status: range ? 206 : 200,
            headers,
        });
    }
    catch {
        await handle.close().catch(() => undefined);
        return notFound();
    }
}
async function serveStatic(request, options, pathname) {
    const resolved = await resolveStaticFile(options.pdfRoots, pathname);
    if (!resolved)
        return notFound();
    const extension = path.extname(resolved.canonicalPath).toLowerCase();
    const contentType = PDF_MIME_TYPES[extension];
    if (!contentType) {
        await resolved.handle.close().catch(() => undefined);
        return notFound();
    }
    const isViewer = pathname === '/pdf/web/viewer.html';
    const parsedRange = parseRange(request.headers.get('range'), resolved.size);
    if (parsedRange === 'invalid') {
        await resolved.handle.close().catch(() => undefined);
        return new Response(null, {
            status: 416,
            headers: {
                'Content-Range': `bytes */${resolved.size}`,
                'Accept-Ranges': 'bytes',
            },
        });
    }
    const range = parsedRange ?? undefined;
    const length = range ? range.end - range.start + 1 : resolved.size;
    const headers = new Headers({
        'Content-Type': contentType,
        'Content-Length': String(length),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        ...staticSecurityHeaders(isViewer, options.viewerFrameAncestors),
    });
    if (range)
        headers.set('Content-Range', `bytes ${range.start}-${range.end}/${resolved.size}`);
    if (request.method === 'HEAD') {
        await resolved.handle.close().catch(() => undefined);
        return new Response(null, { status: range ? 206 : 200, headers });
    }
    try {
        // `streamBody` is a Node-backed Web stream. Keep the runtime stream
        // untouched while using the Node Response constructor's own body type.
        return new Response(streamBody(resolved.handle, range), {
            status: range ? 206 : 200,
            headers,
        });
    }
    catch {
        await resolved.handle.close().catch(() => undefined);
        return notFound();
    }
}
/**
 * Creates the handler for the privileged `mavis-preview` scheme.
 *
 * The viewer and every leased artifact deliberately share the exact same
 * scheme/host (`mavis-preview://preview`) so PDF.js can fetch its file without
 * crossing an origin boundary or receiving a filesystem URL.
 */
export function createDocumentPreviewProtocolHandler(options) {
    return async (request) => {
        let url;
        try {
            url = new URL(request.url);
        }
        catch {
            return notFound();
        }
        if (url.protocol !== PREVIEW_ARTIFACT_SCHEME_V1 ||
            url.hostname !== PREVIEW_ARTIFACT_HOST_V1 ||
            url.port ||
            url.username ||
            url.password) {
            return notFound();
        }
        if (request.method !== 'GET' && request.method !== 'HEAD')
            return methodNotAllowed();
        if (url.hash)
            return notFound();
        if (url.pathname.startsWith('/artifact/')) {
            if (url.search)
                return notFound();
            return serveArtifact(request, options, url.pathname);
        }
        if (url.pathname.startsWith('/pdf/')) {
            if (url.search) {
                // PDF.js's viewer uses a `file` query, so query parameters are valid
                // only on the viewer itself. Static resources must remain immutable
                // path capabilities.
                const isViewer = url.pathname === '/pdf/web/viewer.html';
                if (!isViewer)
                    return notFound();
            }
            return serveStatic(request, options, url.pathname);
        }
        return notFound();
    };
}
