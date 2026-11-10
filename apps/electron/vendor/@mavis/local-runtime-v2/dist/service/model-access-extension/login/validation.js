import { MAX_SECRET_BYTES } from '../credentials/credential-state.js';
export class ModelAccessLoginError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = 'ModelAccessLoginError';
    }
}
function invalid() {
    throw new ModelAccessLoginError('login_invalid');
}
function record(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        invalid();
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
        if (!('value' in descriptor) || !descriptor.enumerable)
            invalid();
    }
    if (Object.getOwnPropertySymbols(value).length)
        invalid();
    return value;
}
function text(value, maximum = 256) {
    if (typeof value !== 'string' ||
        !value.trim() ||
        value.length > maximum ||
        /[\u0000-\u001f]/u.test(value))
        invalid();
    return value;
}
function namespaceText(value) {
    if (typeof value !== 'string' || value.length > 256 || /[\u0000-\u001f]/u.test(value))
        invalid();
    return value;
}
function captureResultIdentity(value, providerId) {
    const identity = record(value);
    if (Object.keys(identity).some((key) => !['providerId', 'region', 'tenant', 'subject', 'accountMasked'].includes(key)))
        invalid();
    if (identity.providerId !== providerId)
        invalid();
    if (identity.accountMasked !== undefined)
        text(identity.accountMasked);
    return Object.freeze({
        region: namespaceText(identity.region),
        tenant: namespaceText(identity.tenant),
        subject: text(identity.subject),
    });
}
export function captureLoginRequest(input) {
    record(input);
    return Object.freeze({
        installationId: text(input.installationId),
        sourceId: text(input.sourceId),
        methodId: text(input.methodId),
        target: text(input.target),
        providerId: text(input.providerId),
        providerKey: text(input.providerKey),
        explicitUserAction: input.explicitUserAction === true,
        dependenciesReady: input.dependenciesReady === true,
        signal: input.signal,
    });
}
function https(value) {
    const url = text(value, 8192);
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
            invalid();
    }
    catch {
        invalid();
    }
    return url;
}
export function captureLoginView(value, kind) {
    const view = record(value);
    if (kind === 'browser-pkce' && view.kind === 'browser')
        return Object.freeze({ kind: 'browser', url: https(view.url) });
    if (kind === 'cli')
        return captureCliView(view);
    if (kind === 'device-code' && view.kind === 'device') {
        if (!Number.isSafeInteger(view.expiresAt) || Number(view.expiresAt) <= Date.now())
            invalid();
        return Object.freeze({
            kind: 'device',
            verificationUrl: https(view.verificationUrl),
            userCode: text(view.userCode),
            expiresAt: view.expiresAt,
        });
    }
    if (kind !== 'secret-form' || view.kind !== 'secret-form')
        invalid();
    return captureSecretForm(view);
}
function captureCliView(view) {
    if (view.kind !== 'cli')
        invalid();
    return Object.freeze({ kind: 'cli', message: text(view.message, 8192) });
}
function captureSecretForm(view) {
    if (!Array.isArray(view.fields) || view.fields.length < 1 || view.fields.length > 16)
        invalid();
    const fields = Array.from(view.fields, (item) => {
        const field = record(item);
        const id = text(field.id, 64);
        if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/u.test(id))
            invalid();
        return Object.freeze({ id, label: text(field.label) });
    });
    if (new Set(fields.map((field) => field.id)).size !== fields.length)
        invalid();
    return Object.freeze({ kind: 'secret-form', fields: Object.freeze(fields) });
}
/** Observe even a malformed flow's result without executing accessors. */
export async function observeLoginResult(value) {
    try {
        if (!value || typeof value !== 'object')
            return;
        const descriptor = Object.getOwnPropertyDescriptor(value, 'result');
        if (!descriptor || !('value' in descriptor) || !(descriptor.value instanceof Promise))
            return;
        await descriptor.value;
    }
    catch {
        /* run/consume owns the stable failure projection, including invalid descriptors. */
    }
}
export function captureLoginFlow(value) {
    const flow = record(value);
    if (!(flow.result instanceof Promise) ||
        typeof flow.cancel !== 'function' ||
        (flow.submit !== undefined && typeof flow.submit !== 'function'))
        invalid();
    return Object.freeze({
        view: flow.view,
        result: flow.result,
        cancel: flow.cancel.bind(value),
        ...(flow.submit
            ? { submit: flow.submit.bind(value) }
            : {}),
    });
}
export function captureLoginValues(view, value) {
    if (view?.kind !== 'secret-form')
        invalid();
    const values = record(value);
    const fields = view.fields.map((field) => field.id);
    if (Object.keys(values).length !== fields.length ||
        Object.keys(values).some((key) => !fields.includes(key)))
        invalid();
    for (const field of fields) {
        if (typeof values[field] !== 'string' ||
            !values[field] ||
            Buffer.byteLength(values[field]) > 16 * 1024)
            invalid();
    }
    if (Buffer.byteLength(JSON.stringify(values)) > 64 * 1024)
        invalid();
    return Object.freeze({ ...values });
}
function jsonChildren(item) {
    if (!Array.isArray(item)) {
        const object = record(item);
        if (Object.keys(object).some((key) => Buffer.byteLength(key) > 4096))
            invalid();
        return Object.values(object);
    }
    if (Object.getPrototypeOf(item) !== Array.prototype ||
        Object.getOwnPropertyNames(item).length !== item.length + 1)
        invalid();
    if (item.length > 8192 ||
        Object.keys(item).length !== item.length ||
        Object.getOwnPropertySymbols(item).length)
        invalid();
    return Array.from({ length: item.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor || !('value' in descriptor))
            invalid();
        return descriptor.value;
    });
}
function jsonPrimitive(value) {
    return (value === null ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value)));
}
/** Plain JSON only: reject getters/toJSON, cycles, holes and lossy JSON coercions. */
function payloadJson(value) {
    let nodes = 0;
    let bytes = 0;
    const visit = (item, depth) => {
        if (++nodes > 8192 || depth > 32)
            invalid();
        if (typeof item === 'string') {
            bytes += Buffer.byteLength(item);
            if (bytes > MAX_SECRET_BYTES)
                invalid();
            return;
        }
        if (jsonPrimitive(item))
            return;
        if (!item || typeof item !== 'object')
            invalid();
        for (const child of jsonChildren(item))
            visit(child, depth + 1);
    };
    visit(value, 0);
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > MAX_SECRET_BYTES - 2048)
        invalid();
    return serialized;
}
export function captureOwnedLoginResult(value, providerId, credentialSchema) {
    const result = record(value);
    if (result.kind !== 'direct-owned' ||
        result.providerId !== providerId ||
        result.credentialSchema !== credentialSchema)
        invalid();
    const identity = captureResultIdentity(result.identity, providerId);
    return {
        identity: Object.freeze({
            providerId,
            region: identity.region,
            tenant: identity.tenant,
            subject: text(identity.subject),
        }),
        payload: payloadJson(result.payload),
    };
}
/**
 * A next-step view an extension sets on a waiting flow. Browser, device and form views follow
 * the same rules as initial views; a CLI view is only ever the initial view of a CLI method.
 */
export function captureNextLoginView(value) {
    const view = record(value);
    if (view.kind === 'browser')
        return captureLoginView(view, 'browser-pkce');
    if (view.kind === 'device')
        return captureLoginView(view, 'device-code');
    if (view.kind === 'secret-form')
        return captureLoginView(view, 'secret-form');
    invalid();
}
/** Stable extension error codes the UI may show: `<provider id>_<reason>` of the flow's provider. */
export function providerLoginErrorCode(error, providerId) {
    if (!error || typeof error !== 'object')
        return undefined;
    const code = error.code;
    if (typeof code !== 'string' || code.length > 96)
        return undefined;
    // Provider ids are `[a-z][a-z0-9-]*`: no pattern metacharacter needs escaping.
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(providerId))
        return undefined;
    return new RegExp(`^${providerId}_[a-z][a-z0-9_]{0,63}$`, 'u').test(code) ? code : undefined;
}
//# sourceMappingURL=validation.js.map