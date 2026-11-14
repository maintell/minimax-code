/** Small shared readers behind the probe's tolerant tool-call parsing. */
export function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function readString(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
/** Tool payloads arrive as JSON strings on the wire and as objects in PTC records. */
export function parseJsonValue(value) {
    if (typeof value !== 'string')
        return value;
    try {
        return JSON.parse(value);
    }
    catch {
        return value;
    }
}
export function unique(values) {
    return [...new Set(values)];
}
//# sourceMappingURL=values.js.map