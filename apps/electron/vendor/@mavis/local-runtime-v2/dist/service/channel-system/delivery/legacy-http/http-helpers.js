/**
 * JSON helpers for the legacy channel HTTP facade.
 *
 * Originally the channel-relevant subset of v1 `api/http-helpers.ts` (MR2
 * migration copy); since MR3 this is the PERMANENT home of the legacy wire
 * helpers. The v2 channel owner keeps serving the old REST surface
 * byte-for-byte (proposal §7.2: the old URLs never die), so the legacy
 * Response construction is quarantined under `delivery/legacy-http/` instead
 * of leaking into `transport/` or `ingress/` (those stay Response-free).
 */
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
export function json(data, init) {
    return new Response(JSON.stringify(data), {
        status: init?.status ?? 200,
        statusText: init?.statusText,
        headers: { ...JSON_HEADERS, ...(init?.headers ?? {}) },
    });
}
export function notFound(pathname) {
    return json({ error: `Local runtime route not found: ${pathname}` }, { status: 404 });
}
export async function readJsonBody(request) {
    try {
        const data = (await request.json());
        return data && typeof data === 'object' && !Array.isArray(data)
            ? data
            : {};
    }
    catch {
        return {};
    }
}
export function readFirstString(data, keys) {
    for (const key of keys) {
        const value = data[key];
        if (typeof value === 'string' && value.length > 0)
            return value;
    }
    return undefined;
}
//# sourceMappingURL=http-helpers.js.map