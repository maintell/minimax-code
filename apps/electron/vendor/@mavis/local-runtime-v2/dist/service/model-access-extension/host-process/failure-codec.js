import { randomUUID } from 'node:crypto';
const MODEL_ACCESS_HOST_MAX_FAILURE_MESSAGE = 8 * 1024;
const MODEL_ACCESS_HOST_MAX_FAILURE_HEADERS = 64;
const REF_PATTERN = /^[a-f0-9-]{16,128}$/u;
const CODE_PATTERN = /^[a-z][a-z0-9_.-]{0,95}$/u;
/** Keeps native errors local to the child while retaining a bounded handle for later classify RPC. */
export class ModelAccessHostFailureStore {
    maxEntries;
    entries = new Map();
    constructor(maxEntries = 256) {
        this.maxEntries = maxEntries;
    }
    remember(error) {
        const ref = randomUUID();
        this.entries.set(ref, error);
        while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next().value;
            if (typeof oldest !== 'string')
                break;
            this.entries.delete(oldest);
        }
        return ref;
    }
    get(ref) {
        return this.entries.get(ref);
    }
    release(ref) {
        this.entries.delete(ref);
    }
    clear() {
        this.entries.clear();
    }
}
export function attachHostFailureRef(error, ref) {
    if (!isObject(error))
        return error;
    try {
        Object.defineProperty(error, 'errorRef', {
            configurable: true,
            enumerable: false,
            value: ref,
            writable: false,
        });
    }
    catch {
        /* Frozen vendor errors are still classified by the explicit response ref. */
    }
    return error;
}
export function hostFailureRef(error) {
    if (!isObject(error))
        return undefined;
    const value = error.errorRef;
    return typeof value === 'string' && REF_PATTERN.test(value) ? value : undefined;
}
/** Serialize only stable diagnostic fields; Error JSON itself is intentionally never trusted. */
export function serializeHostFailure(value) {
    const record = failureRecord(value);
    const name = failureText(value, record, 'name');
    const message = failureText(value, record, 'message');
    const errorMessage = boundedText(record.errorMessage);
    const code = boundedCode(record.code);
    const ref = hostFailureRef(value);
    const status = validStatus(record.status) ? record.status : undefined;
    const headers = boundedHeaders(record.headers);
    return {
        kind: 'error',
        ...(ref ? { ref } : {}),
        ...(name ? { name } : {}),
        ...(message ? { message } : {}),
        ...(errorMessage ? { errorMessage } : {}),
        ...(code ? { code } : {}),
        ...(status === undefined ? {} : { status }),
        ...(headers ? { headers } : {}),
    };
}
function failureRecord(value) {
    return isObject(value) ? value : {};
}
function failureText(value, record, key) {
    return boundedText(record[key] ?? (value instanceof Error ? value[key] : undefined));
}
/** Restore a generic parent-side Error, or the exact child object when its ref is still live. */
export function restoreHostFailure(value, store) {
    const dto = parseHostFailure(value);
    if (dto.ref !== undefined)
        return restoreOriginalFailure(dto.ref, store);
    const result = new Error(dto.message ?? dto.errorMessage ?? dto.code ?? 'host_failure');
    if (dto.name)
        result.name = dto.name;
    if (dto.code)
        define(result, 'code', dto.code);
    if (dto.status !== undefined)
        define(result, 'status', dto.status);
    if (dto.headers)
        define(result, 'headers', dto.headers);
    return result;
}
function restoreOriginalFailure(ref, store) {
    const original = store?.get(ref);
    if (original === undefined)
        throw new Error('host_failure_ref_missing');
    if (original instanceof Error)
        return original;
    throw new Error('host_failure_ref_invalid');
}
/** @internal Exported for focused tests. */
export function parseHostFailure(value) {
    assertHostFailure(value);
    return value;
}
function assertHostFailure(value) {
    if (!isObject(value) || value.kind !== 'error')
        throw new Error('host_failure_invalid');
    if (value.ref !== undefined && !isRef(value.ref))
        throw new Error('host_failure_ref_invalid');
    validateFailureText(value);
    if (value.status !== undefined && !validStatus(value.status))
        throw new Error('host_failure_invalid');
    if (value.headers !== undefined && boundedHeaders(value.headers) === undefined)
        throw new Error('host_failure_invalid');
}
function validateFailureText(value) {
    for (const key of ['name', 'message', 'errorMessage']) {
        if (value[key] !== undefined && boundedText(value[key]) !== value[key])
            throw new Error('host_failure_invalid');
    }
    if (value.code !== undefined && !isCode(value.code))
        throw new Error('host_failure_invalid');
}
function define(target, key, value) {
    Object.defineProperty(target, key, { configurable: true, enumerable: true, value });
}
function boundedText(value) {
    return typeof value === 'string' && value.length <= MODEL_ACCESS_HOST_MAX_FAILURE_MESSAGE
        ? value
        : undefined;
}
function boundedCode(value) {
    return typeof value === 'string' && CODE_PATTERN.test(value) ? value : undefined;
}
function validStatus(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599;
}
function boundedHeaders(value) {
    if (!isObject(value) || Object.keys(value).length > MODEL_ACCESS_HOST_MAX_FAILURE_HEADERS)
        return undefined;
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
        if (key.length > 256 || typeof entry !== 'string' || entry.length > 4096)
            return undefined;
        result[key] = entry;
    }
    return result;
}
function isRef(value) {
    return typeof value === 'string' && REF_PATTERN.test(value);
}
function isCode(value) {
    return typeof value === 'string' && CODE_PATTERN.test(value);
}
function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
//# sourceMappingURL=failure-codec.js.map