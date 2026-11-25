import { ExtensionServiceError } from './errors.js';
const MAX_DEPTH = 64;
/** Serializes a value that must already be plain JSON; anything else is `ARGUMENT_INVALID`. */
export function toJsonText(value, what) {
    if (!isJson(value, 0)) {
        throw new ExtensionServiceError('ARGUMENT_INVALID', `${what} must be plain JSON`);
    }
    return JSON.stringify(value);
}
export function isJsonObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}
/** `value` itself when it is plain JSON, else its JSON round trip; `undefined` when it has none. */
export function asJson(value) {
    if (isJson(value, 0))
        return value;
    try {
        const text = JSON.stringify(value);
        return text === undefined ? undefined : JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
function isJson(value, depth) {
    if (depth > MAX_DEPTH)
        return false;
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return true;
    if (typeof value === 'number')
        return Number.isFinite(value);
    if (Array.isArray(value))
        return value.every((item) => isJson(item, depth + 1));
    if (!isJsonObject(value))
        return false;
    return Object.values(value).every((item) => isJson(item, depth + 1));
}
//# sourceMappingURL=json-value.js.map