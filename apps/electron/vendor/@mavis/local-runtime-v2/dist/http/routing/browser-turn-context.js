const BROWSER_TURN_CONTEXT_PATH = '/mavis/api/session/:sessionId/browser-turn-context';
/** Preserve the existing Browser snapshot URL while Runtime V2 owns its state. */
export function mountBrowserTurnContextRoutes(app, service) {
    app.use(BROWSER_TURN_CONTEXT_PATH, browserTurnContextBoundary);
    app.post(BROWSER_TURN_CONTEXT_PATH, async (context) => {
        if (!service)
            return unavailable();
        const body = await readBody(context.req.raw);
        if (!body)
            return invalidContext('Invalid JSON body');
        const turnId = nonEmptyString(body.turnId) ?? nonEmptyString(body.turn_id);
        if (!turnId)
            return invalidContext('turnId is required');
        try {
            const inAppBrowser = readInAppBrowserState(body.inAppBrowser);
            service.turnContext.record({
                sessionId: context.req.param('sessionId'),
                turnId,
                inAppBrowser,
            });
        }
        catch (error) {
            if (!(error instanceof TypeError))
                throw error;
            return invalidContext(error.message);
        }
        return context.json({ success: true });
    });
    // This URL belongs to v2 even when its service is unavailable; never revive the legacy route.
    app.all(BROWSER_TURN_CONTEXT_PATH, () => Response.json({ error: 'Method not allowed' }, { status: 405 }));
}
const browserTurnContextBoundary = async (context, next) => {
    const pathname = new URL(context.req.url).pathname;
    // Preserve the old host's encoded traversal/separator rejection before one decode.
    if (/%2e|%2f|%5c/iu.test(pathname)) {
        return invalidContext('Invalid Browser context path');
    }
    try {
        decodeURIComponent(pathname);
    }
    catch {
        return invalidContext('Invalid Browser context path');
    }
    await next();
};
async function readBody(request) {
    try {
        const body = await request.json();
        return body && typeof body === 'object' && !Array.isArray(body)
            ? body
            : undefined;
    }
    catch {
        return undefined;
    }
}
function nonEmptyString(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function readInAppBrowserState(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('inAppBrowser must be an object');
    }
    const state = value;
    if (typeof state.visible !== 'boolean') {
        throw new TypeError('inAppBrowser.visible must be a boolean');
    }
    if (typeof state.selectedTab !== 'boolean') {
        throw new TypeError('inAppBrowser.selectedTab must be a boolean');
    }
    return { visible: state.visible, selectedTab: state.selectedTab };
}
function invalidContext(error) {
    return Response.json({ error, code: 'INVALID_BROWSER_TURN_CONTEXT' }, { status: 400 });
}
function unavailable() {
    return Response.json({
        error: 'Browser turn context is unavailable on this runtime',
        code: 'BROWSER_TURN_CONTEXT_UNAVAILABLE',
    }, { status: 503 });
}
//# sourceMappingURL=browser-turn-context.js.map