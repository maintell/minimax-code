import { buildLegacyDaemonProxyPath, json } from './host-helpers.js';
export function extractRawPathname(rawUrl) {
    const match = rawUrl.match(/^[a-z][a-z\d+\-.]*:\/\/[^/?#]*(\/[^?#]*)?/iu);
    if (match)
        return match[1] || '/';
    return rawUrl.split(/[?#]/u, 1)[0] || '/';
}
export function hasUnsafeEncodedLocalRuntimePath(rawUrl) {
    const rawPathname = extractRawPathname(rawUrl);
    if (!rawPathname.startsWith('/mavis/api/'))
        return false;
    return /%2e|%2f|%5c/iu.test(rawPathname);
}
export async function proxyLegacyDaemonApi(input) {
    const proxyPath = buildLegacyDaemonProxyPath(input.url.pathname, input.apiPath, input.url.search, input.root);
    if (!proxyPath) {
        return json({ error: `Invalid legacy daemon proxy path: ${input.apiPath}` }, { status: 400 });
    }
    const response = await input.legacyRuntime.proxyDaemonApiRequest(input.request, proxyPath);
    if (input.fallback && (await isLegacyDaemonBoundaryUnavailable(response))) {
        return await input.fallback();
    }
    return response;
}
export function buildLocalBrowserStatus(dataDir) {
    return json({
        profile: 'default',
        dataDir,
        brokerRunning: false,
        hostConnected: false,
        socketPath: '',
        claims: { active: [], detached: [] },
    });
}
export function buildLocalBrowserInstallInfo(dataDir) {
    return json({
        installed: false,
        profile: 'default',
        dataDir,
    });
}
export function buildLocalBrowserProfiles() {
    return json({
        currentProfile: 'default',
        profiles: [{ profile: 'default', installed: false }],
    });
}
export async function normalizeBrowserStatusResponse(response) {
    if (!response.ok)
        return response;
    const payload = (await response
        .clone()
        .json()
        .catch(() => undefined));
    if (!payload)
        return response;
    return json(normalizeBrowserStatusPayload(payload), {
        status: response.status,
        statusText: response.statusText,
    });
}
async function isLegacyDaemonBoundaryUnavailable(response) {
    if (response.status !== 403 && response.status !== 503)
        return false;
    const body = (await response
        .clone()
        .json()
        .catch(() => undefined));
    return body?.code === 'LEGACY_DAEMON_DISABLED' || body?.code === 'LEGACY_DAEMON_UNAVAILABLE';
}
function normalizeBrowserStatusPayload(payload) {
    if (!Array.isArray(payload.claims))
        return payload;
    const active = [];
    const detached = [];
    for (const claim of payload.claims) {
        if (!claim || typeof claim !== 'object')
            continue;
        const normalized = normalizeBrowserClaim(claim);
        if (isDetachedBrowserClaim(claim)) {
            detached.push(normalized);
        }
        else {
            active.push(normalized);
        }
    }
    return {
        ...payload,
        claims: { active, detached },
    };
}
function normalizeBrowserClaim(claim) {
    const sessionId = readOptionalString(claim['session_id']) ??
        readOptionalString(claim['sessionId']) ??
        readOptionalString(claim['profile']) ??
        '';
    const sessionKind = readOptionalString(claim['session_kind']) ?? readOptionalString(claim['sessionKind']);
    const tabIds = Array.isArray(claim['tab_ids'])
        ? claim['tab_ids'].filter((item) => typeof item === 'number')
        : typeof claim['tabId'] === 'number'
            ? [claim['tabId']]
            : [];
    const createdAt = readTimestampMs(claim['created_at'] ?? claim['claimedAt'] ?? claim['claimed_at']);
    return {
        session_id: sessionId,
        session_kind: sessionKind === 'worker' ? 'worker' : 'root',
        tab_ids: tabIds,
        created_at: createdAt,
    };
}
function isDetachedBrowserClaim(claim) {
    return (claim['detachedAt'] != null ||
        claim['detached_at'] != null ||
        claim['sessionId'] === null ||
        claim['session_id'] === null);
}
function readOptionalString(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function readTimestampMs(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string' && value.trim()) {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return 0;
}
//# sourceMappingURL=legacy-fallbacks.js.map