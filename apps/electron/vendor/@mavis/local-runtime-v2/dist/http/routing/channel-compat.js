/** `/mavis/api/<prefix>` route patterns owned by the channel compat surface. */
const CHANNEL_COMPAT_PATTERNS = [
    '/mavis/api/channel/connections',
    '/mavis/api/channel/connections/*',
    '/mavis/api/channel-bridge',
    '/mavis/api/channel-bridge/*',
    '/mavis/api/im-bridge',
    '/mavis/api/im-bridge/*',
    '/mavis/api/lark/onboard',
    '/mavis/api/lark/onboard/*',
    '/mavis/api/channel-route',
    '/mavis/api/channel-route/*',
];
export function mountChannelCompatRoutes(app, surface) {
    if (!surface)
        return;
    for (const pattern of CHANNEL_COMPAT_PATTERNS) {
        app.all(pattern, async (c) => {
            const request = c.req.raw;
            const url = new URL(request.url);
            // v1 parity: the api path is the decoded pathname relative to
            // `/mavis/api`, split with empty segments dropped (`splitPath`).
            const parts = decodeURIComponent(url.pathname)
                .replace(/^\/mavis\/api/u, '')
                .split('/')
                .filter(Boolean);
            const response = await surface.dispatch({
                request,
                method: request.method,
                parts,
                url,
            });
            if (response)
                return response;
            // Defensive: a matched pattern must be recognized by the surface. A
            // structured legacy 404 (never a fallthrough) keeps §7.2 intact even
            // if the pattern list and the surface ever drift.
            return c.json({ error: `Local runtime route not found: /${parts.join('/')}` }, 404);
        });
    }
}
//# sourceMappingURL=channel-compat.js.map