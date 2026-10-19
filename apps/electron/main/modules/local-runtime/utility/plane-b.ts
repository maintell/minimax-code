/**
 * Plane B (element-src binaries) disk serving for utility-process runtime
 * mode — proposal §2.2 (B1).
 *
 * `<img src="app://.../mavis/api/file/preview?path=...">` requests are
 * issued by Chromium itself (renderer JS never sees them), so they arrive
 * at the main-process app:// protocol handler, not the renderer's
 * MessagePort. In utility mode main serves these straight from disk —
 * "whoever needs the file reads it in its own process" — instead of
 * ferrying bytes out of the utility process.
 *
 * Semantics mirror `packages/local-runtime/src/files/api.ts#serveFilePreview`
 * byte-for-byte (image-only MIME allowlist, `..` traversal gate, 403/404
 * JSON errors, private 300s cache header) so flipping the flag does not
 * change observable behavior.
 *
 * Scope note: `/mavis/api/file/content` returns JSON (renderer JS fetch →
 * plane A) and agent avatars come out of the runtime's SQLite store, so
 * neither is served here; anything this module declines falls through to
 * main's transitional transport forward.
 */

import { stat, readFile } from "node:fs/promises";
import { extname } from "node:path";
/** Mirror of files/api.ts FILE_PREVIEW_IMAGE_MIME_TYPES — keep in sync. */
const PREVIEW_IMAGE_MIME_TYPES = new Map([
    ['.bmp', 'image/bmp'],
    ['.gif', 'image/gif'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.png', 'image/png'],
    ['.svg', 'image/svg+xml'],
    ['.webp', 'image/webp'],
]);
const PREVIEW_PATHNAME = '/mavis/api/file/preview';
function json(body, init) {
    return new Response(JSON.stringify(body), {
        status: init.status,
        headers: { 'Content-Type': 'application/json' },
    });
}
/**
 * Serves a plane-B binary from disk, or returns null when the request is
 * not a plane-B disk read (caller forwards it over the runtime transport).
 */
export async function serveUtilityPlaneBRequest(method, url) {
    if (method !== 'GET')
        return null;
    let pathname;
    try {
        pathname = decodeURIComponent(url.pathname);
    }
    catch {
        return null;
    }
    if (pathname !== PREVIEW_PATHNAME)
        return null;
    const filePath = url.searchParams.get('path');
    if (!filePath) {
        return json({ error: 'path is required' }, { status: 400 });
    }
    if (filePath.includes('..')) {
        return json({ error: 'Path traversal not allowed' }, { status: 403 });
    }
    const contentType = PREVIEW_IMAGE_MIME_TYPES.get(extname(filePath).toLowerCase());
    if (!contentType) {
        return json({ error: 'Only image files are allowed' }, { status: 403 });
    }
    try {
        const info = await stat(filePath);
        if (!info.isFile())
            return json({ error: 'File not found' }, { status: 404 });
        const data = await readFile(filePath);
        const body = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        return new Response(body, {
            headers: {
                'Content-Type': contentType,
                'Cache-Control': 'private, max-age=300',
            },
        });
    }
    catch {
        return json({ error: 'File not found' }, { status: 404 });
    }
}
