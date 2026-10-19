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
export function parseRespData(raw) {
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=http-helpers.js.map