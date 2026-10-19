import { HTML_PREVIEW_BRIDGE_SCRIPT_MAX_BYTES, } from '../../service/workspace/index.js';
const PREVIEW_PATH = '/mavis/api/file/html-preview';
/** Raw HTML/resource delivery keeps its existing URL, independently of JSON DesktopService RPC. */
export function mountWorkspaceHtmlPreviewRoutes(app, service) {
    app.use(PREVIEW_PATH, previewBoundary);
    app.use(`${PREVIEW_PATH}/*`, previewBoundary);
    app.post(PREVIEW_PATH, (context) => createPreview(context.req.raw, service));
    app.post(`${PREVIEW_PATH}/renew`, (context) => updatePreview(context.req.raw, service, 'renew'));
    app.delete(PREVIEW_PATH, (context) => updatePreview(context.req.raw, service, 'release'));
    app.get(`${PREVIEW_PATH}/*`, async (context) => {
        if (!service)
            return unavailable();
        const path = decodeURIComponent(new URL(context.req.url).pathname).slice(PREVIEW_PATH.length + 1);
        const [token = '', ...parts] = path.split('/');
        const result = await service.readResource(token, parts.join('/'), context.req.header('range') ?? null);
        if (!result.ok) {
            return Response.json({ error: result.error, code: result.code }, { status: result.status });
        }
        return new Response(result.body, { status: result.status, headers: result.headers });
    });
    // These URLs belong to v2 even when its service is unavailable; never revive the legacy path.
    app.all(PREVIEW_PATH, () => Response.json({ error: 'Method not allowed' }, { status: 405 }));
    app.all(`${PREVIEW_PATH}/*`, () => Response.json({ error: 'Method not allowed' }, { status: 405 }));
}
const previewBoundary = async (context, next) => {
    // Hono dispatches HEAD through GET; reject before opening an unconsumed resource stream.
    if (context.req.method === 'HEAD') {
        return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    const pathname = new URL(context.req.url).pathname;
    // Preserve the old host's encoded traversal/separator rejection before a single decode.
    if (/%2e|%2f|%5c/iu.test(pathname)) {
        return Response.json({ error: 'Invalid preview path' }, { status: 400 });
    }
    try {
        decodeURIComponent(pathname);
    }
    catch {
        return Response.json({ error: 'Invalid preview path' }, { status: 400 });
    }
    if (context.req.method === 'POST' || context.req.method === 'DELETE') {
        const contentType = context.req.header('content-type')?.split(';')[0]?.trim().toLowerCase();
        if (contentType !== 'application/json') {
            return Response.json({ error: 'Content-Type must be application/json' }, { status: 415 });
        }
    }
    await next();
};
async function readBody(request) {
    try {
        const body = await request.json();
        return body && typeof body === 'object' && !Array.isArray(body)
            ? body
            : {};
    }
    catch {
        return {};
    }
}
function nonEmptyString(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function validateCreateBody(body) {
    if (!nonEmptyString(body.workspace)) {
        return Response.json({ error: 'workspace is required' }, { status: 400 });
    }
    if (!nonEmptyString(body.path)) {
        return Response.json({ error: 'path is required' }, { status: 400 });
    }
    if (body.managed !== undefined && typeof body.managed !== 'boolean') {
        return Response.json({ error: 'managed must be a boolean' }, { status: 400 });
    }
    if (body.bridgeScript !== undefined && typeof body.bridgeScript !== 'string') {
        return Response.json({ error: 'bridgeScript must be a string' }, { status: 400 });
    }
    const bridgeScript = nonEmptyString(body.bridgeScript);
    if (bridgeScript &&
        Buffer.byteLength(bridgeScript, 'utf8') > HTML_PREVIEW_BRIDGE_SCRIPT_MAX_BYTES) {
        return Response.json({ error: 'bridgeScript is too large' }, { status: 413 });
    }
    return undefined;
}
async function createPreview(request, service) {
    if (!service)
        return unavailable();
    const body = await readBody(request);
    const invalid = validateCreateBody(body);
    if (invalid)
        return invalid;
    const result = await service.create(body.workspace, body.path, Date.now(), {
        bridgeScriptTag: nonEmptyString(body.bridgeScript),
        managed: body.managed === true,
    });
    return result.ok
        ? Response.json({ url: result.url, ...(result.lease ? { lease: result.lease } : {}) })
        : Response.json({ error: result.error, code: result.code }, { status: result.status });
}
async function updatePreview(request, service, action) {
    if (!service)
        return unavailable();
    const body = await readBody(request);
    const token = nonEmptyString(body.token);
    const ownerToken = nonEmptyString(body.ownerToken);
    if (!token || !ownerToken) {
        return Response.json({ error: 'token and ownerToken must be non-empty strings' }, { status: 400 });
    }
    const result = service.update(token, ownerToken, action);
    return result.ok
        ? Response.json({ ok: true })
        : Response.json({ error: result.error, code: result.code }, { status: result.status });
}
function unavailable() {
    return Response.json({ error: 'HTML preview is unavailable on this runtime', code: 'HTML_PREVIEW_UNAVAILABLE' }, { status: 503 });
}
//# sourceMappingURL=workspace-html-preview.js.map