import { createHash } from 'node:crypto';
import { captureRequestModels } from '../request/catalog-validation.js';
export class ModelAccessApiScanError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = 'ModelAccessApiScanError';
    }
}
function invalid() {
    throw new ModelAccessApiScanError('api_scan_invalid');
}
function text(value, limit = 256) {
    if (typeof value !== 'string' ||
        !value.trim() ||
        value.length > limit ||
        /[\u0000-\u001f\u007f]/u.test(value))
        invalid();
    return value;
}
function record(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype)
        invalid();
    const result = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || (keys && !keys.includes(key)))
            invalid();
        result[key] = ownValue(value, key);
    }
    return result;
}
function ownValue(value, key) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
        invalid();
    return descriptor.value;
}
function array(value, capture, limit) {
    if (!Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Array.prototype ||
        value.length > limit ||
        Reflect.ownKeys(value).length !== value.length + 1)
        invalid();
    const result = [];
    for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
            invalid();
        result.push(capture(descriptor.value));
    }
    return Object.freeze(result);
}
function signal(value) {
    if (!(value instanceof AbortSignal))
        invalid();
    return value;
}
export function captureApiScan(input) {
    const item = record(input, ['installationId', 'sourceId', 'readerId', 'targets', 'signal']);
    const targets = item.targets === undefined ? undefined : array(item.targets, (value) => text(value), 128);
    if (targets && (!targets.length || new Set(targets).size !== targets.length))
        invalid();
    return Object.freeze({
        installationId: text(item.installationId),
        sourceId: text(item.sourceId),
        readerId: text(item.readerId),
        targets,
        signal: signal(item.signal),
    });
}
export function captureApiImport(input) {
    const item = record(input, ['candidateId', 'signal']);
    return Object.freeze({ candidateId: text(item.candidateId), signal: signal(item.signal) });
}
function headers(value) {
    if (value === undefined)
        return undefined;
    const item = record(value);
    if (Object.keys(item).length > 64)
        invalid();
    const result = Object.create(null);
    for (const key of Object.keys(item).sort()) {
        if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/iu.test(key) || Object.hasOwn(result, key.toLowerCase()))
            invalid();
        result[key.toLowerCase()] = text(item[key], 16_384);
    }
    return Object.freeze(result);
}
function candidate(value, targets) {
    const item = record(value, [
        'target',
        'fingerprint',
        'upstream',
        'baseUrl',
        'api',
        'apiKey',
        'headers',
        'models',
    ]);
    const target = text(item.target);
    if (!targets.includes(target))
        invalid();
    const baseUrl = text(item.baseUrl, 4096);
    let endpoint;
    try {
        endpoint = new URL(baseUrl);
    }
    catch {
        return invalid();
    }
    if (!['http:', 'https:'].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash)
        invalid();
    const capturedHeaders = headers(item.headers);
    const api = text(item.api);
    const models = captureRequestModels(item.models);
    if (models.some((model) => model.api !== api))
        invalid();
    return Object.freeze({
        target,
        fingerprint: text(item.fingerprint, 1024),
        upstream: text(item.upstream),
        baseUrl,
        api,
        apiKey: text(item.apiKey, 65_536),
        ...(capturedHeaders ? { headers: capturedHeaders } : {}),
        models,
    });
}
export function captureApiCandidates(value, targets) {
    try {
        const result = array(value, (item) => candidate(item, targets), 256);
        if (new Set(result.map((item) => JSON.stringify([item.target, item.fingerprint]))).size !==
            result.length)
            invalid();
        return result;
    }
    catch {
        return invalid();
    }
}
/** Runtime-only integrity check; a reader fingerprint alone cannot authorize changed credentials. */
export function apiCandidateHash(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function apiSourceKey(source) {
    return JSON.stringify([source.installationId, source.sourceId, source.readerId]);
}
//# sourceMappingURL=validation.js.map