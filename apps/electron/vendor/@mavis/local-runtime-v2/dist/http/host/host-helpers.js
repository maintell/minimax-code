import { json, notFound, readJsonBody } from '../../infra/transport/host-http.js';
import { hostDiagnosticsUnavailable, } from '../../infra/diagnostics/diagnostics-provider.js';
import { routeDesktopServiceRequest, } from '../desktop/routes.js';
import { routeDesktopServiceWithLegacyMavisApiCompat } from '../desktop/legacy-mavis-api-compat.js';
export async function routeDiagnosticsApi(hostDiagnosticsProvider, request, parts) {
    const method = request.method.toUpperCase();
    if (method === 'POST' && parts[1] === 'upload') {
        return json(hostDiagnosticsProvider?.uploadDiagnosticBundle
            ? await hostDiagnosticsProvider.uploadDiagnosticBundle(await readJsonBody(request))
            : hostDiagnosticsUnavailable('diagnostic-upload'));
    }
    return notFound(`/diagnostics/${parts.slice(1).join('/')}`);
}
const DESKTOP_WEBSITE_API_PREFIX = '/minimax-desktop/api/v1';
export async function routeLocalApiHostEntryRequest({ request, pathname, runtimeStartupToken, desktopServiceHandler, }) {
    if (pathname === '/mavis/health') {
        return {
            type: 'response',
            response: json({
                status: 'ok',
                runtime: 'local-runtime',
                ...(runtimeStartupToken ? { startupToken: runtimeStartupToken } : {}),
            }),
        };
    }
    if (pathname === '/mavis/api/version') {
        return {
            type: 'response',
            response: json({
                version: 'local-runtime',
                latestVersion: null,
                updateAvailable: false,
                updateCommand: '',
            }),
        };
    }
    if (pathname === '/mavis/api/update') {
        return { type: 'response', response: json({ ok: true }) };
    }
    if (pathname === `${DESKTOP_WEBSITE_API_PREFIX}/drive` ||
        pathname.startsWith(`${DESKTOP_WEBSITE_API_PREFIX}/drive/`)) {
        // Desktop's public prefix and managed BizGateway's `/mavis/api/v1`
        // prefix are different contract layers. This is only a local-runtime
        // compatibility map: keep the original Request so query, body, method,
        // and the existing website route's strict validation stay unchanged.
        // PV traffic remains the independent website traffic operation below.
        return {
            type: 'api',
            apiPath: pathname.slice(DESKTOP_WEBSITE_API_PREFIX.length),
        };
    }
    const desktopServiceRoute = await routeDesktopServiceWithLegacyMavisApiCompat(request, desktopServiceHandler ?? routeDesktopServiceRequest);
    if (desktopServiceRoute)
        return desktopServiceRoute;
    if (!pathname.startsWith('/mavis/api/')) {
        return { type: 'response', response: notFound(pathname) };
    }
    return { type: 'api', apiPath: pathname.slice('/mavis/api'.length) };
}
//# sourceMappingURL=host-helpers.js.map