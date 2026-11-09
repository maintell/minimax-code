export class ModelAccessRequestError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = 'ModelAccessRequestError';
    }
}
function invalid() {
    throw new ModelAccessRequestError('request_invalid');
}
export function requestRecord(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        invalid();
    const result = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || !keys.includes(key))
            invalid();
        result[key] = dataValue(Object.getOwnPropertyDescriptor(value, key));
    }
    return result;
}
function dataValue(descriptor) {
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
        invalid();
    return descriptor.value;
}
function text(value) {
    if (typeof value !== 'string' ||
        !value.trim() ||
        value.length > 4096 ||
        /[\u0000-\u001f]/u.test(value))
        invalid();
    return value;
}
export function captureModelAccessCall(value) {
    const item = requestRecord(value, ['providerKey', 'signal', 'dependenciesReady', 'sessionId']);
    if (!(item.signal instanceof AbortSignal))
        invalid();
    return Object.freeze({
        providerKey: text(item.providerKey),
        signal: item.signal,
        dependenciesReady: item.dependenciesReady === true,
        ...(item.sessionId === undefined ? {} : { sessionId: text(item.sessionId) }),
    });
}
export function captureBoundTransport(value) {
    const item = requestRecord(value, [
        'api',
        'modelId',
        'baseUrl',
        'apiKey',
        'headers',
        'fetch',
        'dispose',
    ]);
    const baseUrl = text(item.baseUrl);
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        invalid();
    validateOptionalTransport(item);
    const headers = item.headers === undefined ? undefined : captureHeaders(item.headers);
    return Object.freeze({
        api: text(item.api),
        modelId: text(item.modelId),
        baseUrl,
        ...(item.apiKey === undefined ? {} : { apiKey: item.apiKey }),
        ...(headers ? { headers } : {}),
        ...(item.fetch ? { fetch: item.fetch } : {}),
        ...(item.dispose ? { dispose: item.dispose } : {}),
    });
}
function validateOptionalTransport(item) {
    if (item.apiKey !== undefined && typeof item.apiKey !== 'string')
        invalid();
    if (item.fetch !== undefined && typeof item.fetch !== 'function')
        invalid();
    if (item.dispose !== undefined && typeof item.dispose !== 'function')
        invalid();
}
function captureHeaders(value) {
    if (!value || typeof value !== 'object')
        invalid();
    const item = requestRecord(value, Object.getOwnPropertyNames(value));
    if (Object.keys(item).length > 128)
        invalid();
    const headers = Object.create(null);
    for (const [key, entry] of Object.entries(item)) {
        if (typeof entry !== 'string' ||
            /[\r\n]/u.test(entry) ||
            !/^[!#$%&'*+.^_`|~0-9a-z-]+$/iu.test(key))
            invalid();
        headers[key] = entry;
    }
    return Object.freeze(headers);
}
//# sourceMappingURL=validation.js.map