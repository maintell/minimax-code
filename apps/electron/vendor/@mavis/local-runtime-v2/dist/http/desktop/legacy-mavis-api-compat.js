const LEGACY_MAVIS_API_PREFIX = '/mavis/api';
export async function routeDesktopServiceWithLegacyMavisApiCompat(request, handler) {
    const url = new URL(request.url);
    if (shouldBypassDesktopServiceForLegacyMavisApi(url.pathname)) {
        return { type: 'api', apiPath: url.pathname.slice(LEGACY_MAVIS_API_PREFIX.length) };
    }
    const response = await handler(request);
    if (!response)
        return undefined;
    return { type: 'response', response };
}
function shouldBypassDesktopServiceForLegacyMavisApi(pathname) {
    return (pathname === '/mavis/api/session/search' ||
        pathname.startsWith('/mavis/api/session/') ||
        /^\/mavis\/api\/agent\/[^/]+\/session(?:\/|$)/u.test(pathname));
}
//# sourceMappingURL=legacy-mavis-api-compat.js.map