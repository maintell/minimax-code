import { captureSourceRef } from '../credentials/credential-state.js';
export class ModelAccessBorrowError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = 'ModelAccessBorrowError';
    }
}
function invalid() {
    throw new ModelAccessBorrowError('borrow_invalid');
}
function dataValue(descriptor) {
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
        invalid();
    return descriptor.value;
}
function record(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype)
        invalid();
    const result = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || !keys.includes(key))
            invalid();
        result[key] = dataValue(Object.getOwnPropertyDescriptor(value, key));
    }
    return result;
}
function text(value, empty = false) {
    if (typeof value !== 'string' || value.length > 256 || /[\u0000-\u001f]/u.test(value))
        invalid();
    if (!empty && !value.trim())
        invalid();
    return value;
}
function signal(value) {
    if (value === undefined)
        return undefined;
    if (!(value instanceof AbortSignal))
        invalid();
    return value;
}
export function captureBorrowDiscovery(input) {
    const item = record(input, ['sourceRef', 'signal']);
    return Object.freeze({
        sourceRef: captureSourceRef(item.sourceRef),
        signal: signal(item.signal),
    });
}
export function captureBorrowResolution(input) {
    const item = record(input, ['providerKey', 'signal', 'dependenciesReady']);
    const capturedSignal = signal(item.signal);
    if (!capturedSignal)
        invalid();
    return Object.freeze({
        providerKey: text(item.providerKey),
        signal: capturedSignal,
        dependenciesReady: item.dependenciesReady === true,
    });
}
export function captureBorrowRenewal(input, issued) {
    const item = record(input, ['providerKey', 'signal', 'dependenciesReady', 'previous', 'mode']);
    const previous = item.previous;
    if (!issued.has(previous) || (item.mode !== 'normal' && item.mode !== 'forced'))
        invalid();
    const resolution = captureBorrowResolution({
        providerKey: item.providerKey,
        signal: item.signal,
        dependenciesReady: item.dependenciesReady === true,
    });
    if (previous.binding.providerKey !== resolution.providerKey)
        invalid();
    return Object.freeze({ ...resolution, previous, mode: item.mode });
}
export function captureBorrowSelection(input) {
    const item = record(input, [
        'sourceRef',
        'signal',
        'providerKey',
        'providerId',
        'explicitUserAction',
        'dependenciesReady',
    ]);
    return Object.freeze({
        sourceRef: captureSourceRef(item.sourceRef),
        signal: signal(item.signal),
        providerKey: text(item.providerKey),
        providerId: text(item.providerId),
        explicitUserAction: item.explicitUserAction === true,
        dependenciesReady: item.dependenciesReady === true,
    });
}
function sameSource(left, right) {
    return (left.installationId === right.installationId &&
        left.sourceId === right.sourceId &&
        left.variant === right.variant &&
        left.target === right.target);
}
function discovery(value, source) {
    const item = record(value, ['providerId', 'sourceRef', 'status', 'accountMasked', 'plan']);
    const sourceRef = captureSourceRef(item.sourceRef);
    if (!sameSource(sourceRef, source))
        invalid();
    const status = item.status;
    if (status !== 'available' &&
        status !== 'signed_out' &&
        status !== 'expired' &&
        status !== 'unavailable' &&
        status !== 'unknown')
        invalid();
    return Object.freeze({
        providerId: text(item.providerId),
        sourceRef,
        status,
        ...discoveryAccount(item, status),
    });
}
function discoveryAccount(item, status) {
    const accountMasked = item.accountMasked === undefined ? undefined : text(item.accountMasked);
    const plan = item.plan === undefined ? undefined : text(item.plan);
    if (status !== 'available' && status !== 'expired')
        return {};
    return {
        ...(accountMasked === undefined ? {} : { accountMasked }),
        ...(plan === undefined ? {} : { plan }),
    };
}
export function captureBorrowDiscoveries(value, source) {
    if (!Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Array.prototype ||
        value.length > 128)
        invalid();
    if (Reflect.ownKeys(value).length !== value.length + 1)
        invalid();
    const result = [];
    for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
            invalid();
        result.push(discovery(descriptor.value, source));
    }
    if (new Set(result.map((item) => item.providerId)).size !== result.length)
        invalid();
    return Object.freeze(result);
}
function expiry(value, allowExpired) {
    if (value === undefined)
        return undefined;
    if (!Number.isSafeInteger(value) || Number(value) < 1)
        invalid();
    if (!allowExpired && Number(value) <= Date.now())
        throw new ModelAccessBorrowError('borrow_expired');
    return value;
}
export function captureBorrowCredential(value, providerId, allowExpired = false) {
    const item = record(value, ['identity', 'expiresAt', 'payload']);
    const identity = record(item.identity, [
        'providerId',
        'region',
        'tenant',
        'subject',
        'accountMasked',
    ]);
    if (identity.providerId !== providerId)
        invalid();
    if (identity.accountMasked !== undefined)
        text(identity.accountMasked);
    const expiresAt = expiry(item.expiresAt, allowExpired);
    return Object.freeze({
        identity: Object.freeze({
            providerId,
            region: text(identity.region, true),
            tenant: text(identity.tenant, true),
            subject: text(identity.subject),
        }),
        ...(typeof expiresAt === 'number' ? { expiresAt } : {}),
        payload: item.payload,
    });
}
//# sourceMappingURL=validation.js.map