import { LegacyOpencodeMigrationError } from '../legacy-opencode/legacy-opencode-migrator.js';
import { LocalAgentContractError } from '../agent/contract.js';
import { CHANNEL_CLIENT_UNAVAILABLE, LocalChannelClientUnavailableError, } from './host-channel-port.js';
import { extractRawPathname, hasUnsafeEncodedLocalRuntimePath } from './legacy-fallbacks.js';
import { json, notFound, routeLocalApiHostEntryRequest } from './host-helpers.js';
import { emitLocalLegacyMigrationTelemetry, serializeLegacyMigrationFailure, } from './host-support.js';
/**
 * Stable primary-agent binding-conflict wire contract (MR3): the throwing
 * class lives in the v2 channel system now, so recognition is structural by
 * `code` — cross-package instances must keep mapping to the legacy 409 body.
 */
const PRIMARY_AGENT_CHANNEL_CONFLICT = 'PRIMARY_AGENT_CHANNEL_CONFLICT';
function isPrimaryAgentChannelConflictLike(err) {
    return (err instanceof Error && err.code === PRIMARY_AGENT_CHANNEL_CONFLICT);
}
/** Same structural rule for the no-live-client contract (v1 or v2 thrown). */
function isChannelClientUnavailableLike(err) {
    return (err instanceof LocalChannelClientUnavailableError ||
        (err instanceof Error && err.code === CHANNEL_CLIENT_UNAVAILABLE));
}
export async function routeLocalRuntimeRequest({ request, telemetry, resolveApiPath, routeApi, }) {
    if (hasUnsafeEncodedLocalRuntimePath(request.url)) {
        return json({ error: `Invalid encoded local runtime path: ${extractRawPathname(request.url)}` }, { status: 400 });
    }
    const url = new URL(request.url);
    const pathname = decodeURIComponent(url.pathname);
    try {
        const apiPath = await resolveApiPath(pathname, url);
        return apiPath instanceof Response ? apiPath : await routeApi(request, apiPath, url);
    }
    catch (err) {
        if (err instanceof LegacyOpencodeMigrationError) {
            emitLocalLegacyMigrationTelemetry({
                telemetry,
                sessionId: err.record.legacySessionId,
                error: err,
            });
            return json(serializeLegacyMigrationFailure(err), { status: 500 });
        }
        if (err instanceof LocalAgentContractError) {
            return json({ error: err.message, code: err.code, ...(err.details ?? {}) }, { status: err.status });
        }
        // Structural checks for the two channel-owned stable contracts that may
        // cross any host route (the classes live in the v2 channel system since
        // MR3; instance identity cannot cross the package boundary).
        if (isPrimaryAgentChannelConflictLike(err)) {
            return json({
                error: 'Primary Agent channel binding conflicts with an existing binding',
                code: PRIMARY_AGENT_CHANNEL_CONFLICT,
                status: 'conflict',
            }, { status: 409 });
        }
        if (isChannelClientUnavailableLike(err)) {
            return json({ error: 'Channel client is unavailable', code: CHANNEL_CLIENT_UNAVAILABLE }, { status: 503 });
        }
        const message = err instanceof Error ? err.message : String(err);
        return json({ error: message }, { status: 500 });
    }
}
export async function resolveLocalApiHostEntryPath({ request, pathname, runtimeStartupToken, desktopServiceHandler, }) {
    const entryRoute = await routeLocalApiHostEntryRequest({
        request,
        pathname,
        runtimeStartupToken,
        desktopServiceHandler,
    });
    return entryRoute.type === 'response' ? entryRoute.response : entryRoute.apiPath;
}
export function resolveStrictMavisApiPath(pathname) {
    return pathname.startsWith('/mavis/api/')
        ? pathname.slice('/mavis/api'.length)
        : notFound(pathname);
}
//# sourceMappingURL=host-routing.js.map