export function appendSearchParam(url, key, value) {
    if (value === undefined)
        return;
    url.searchParams.set(key, String(value));
}
export function encodeSegment(value) {
    return encodeURIComponent(value);
}
export function asObject(value) {
    return isObject(value) ? value : {};
}
export function isObject(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
export function asArray(value) {
    return Array.isArray(value) ? value : [];
}
export function asStringArray(value) {
    if (!Array.isArray(value))
        return undefined;
    return value.filter((item) => typeof item === 'string');
}
export function maybeString(value) {
    return typeof value === 'string' ? value : undefined;
}
export function readString(value) {
    return maybeString(value);
}
export function maybeNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return undefined;
}
export function readNumber(value) {
    return maybeNumber(value);
}
export function maybeBoolean(value) {
    return typeof value === 'boolean' ? value : undefined;
}
export function jsonStringOrString(value) {
    if (typeof value === 'string')
        return value;
    if (value === undefined || value === null)
        return undefined;
    try {
        return JSON.stringify(value);
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=desktop-session-mapper-support.js.map