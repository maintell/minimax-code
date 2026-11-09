import { createHash } from 'node:crypto';
export class ModelAccessCredentialError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = 'ModelAccessCredentialError';
    }
}
export const SECRET_CHUNK_BYTES = 1024;
export const MAX_SECRET_BYTES = 128 * 1024;
const CREDENTIAL_STATE_VERSION = 2;
const HASH = /^[a-f0-9]{64}$/u;
const KINDS = new Set(['direct-owned', 'borrowed-current', 'public']);
export function digest(value) {
    return createHash('sha256').update(value).digest('hex');
}
function invalid() {
    throw new ModelAccessCredentialError('credential_state_invalid');
}
/** Own enumerable data properties only; no accessor or prototype trickery reaches the parser. */
function plainRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype)
        invalid();
    if (Reflect.ownKeys(value).some((key) => typeof key !== 'string'))
        invalid();
    const captured = Object.create(null);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (!('value' in descriptor) || !descriptor.enumerable)
            invalid();
        captured[key] = descriptor.value;
    }
    return captured;
}
function record(value, keys) {
    const item = plainRecord(value);
    if (Object.keys(item).some((key) => !keys.includes(key)))
        invalid();
    return item;
}
function text(value) {
    if (typeof value !== 'string' ||
        !value.trim() ||
        value.length > 256 ||
        /[\u0000-\u001f]/u.test(value))
        invalid();
    return value;
}
function namespaceText(value) {
    if (typeof value !== 'string' || value.length > 256 || /[\u0000-\u001f]/u.test(value))
        invalid();
    return value;
}
function integer(value) {
    if (!Number.isSafeInteger(value) || value < 1)
        invalid();
    return value;
}
function maskedAccount(value) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'string' ||
        !value.trim() ||
        value.length > 128 ||
        /[\u0000-\u001f]/u.test(value))
        invalid();
    return value;
}
function slotName(value) {
    if (value !== 'A' && value !== 'B')
        invalid();
    return value;
}
export function otherSlot(slot) {
    return slot === 'A' ? 'B' : 'A';
}
export function captureSourceRef(value) {
    const item = record(value, ['installationId', 'sourceId', 'variant', 'target', 'selector']);
    if (item.selector !== 'current')
        invalid();
    return Object.freeze({
        installationId: text(item.installationId),
        sourceId: text(item.sourceId),
        variant: text(item.variant),
        target: text(item.target),
        selector: 'current',
    });
}
export function captureIdentity(value, providerId) {
    const item = record(value, ['providerId', 'region', 'tenant', 'subject', 'accountMasked']);
    const identity = {
        providerId: text(item.providerId),
        region: namespaceText(item.region),
        tenant: namespaceText(item.tenant),
        subject: text(item.subject),
    };
    if (identity.providerId !== providerId)
        invalid();
    if (item.accountMasked !== undefined)
        text(item.accountMasked);
    return Object.freeze(identity);
}
export function secretSlot(binding, slot = binding.slot ?? 'A') {
    return Object.freeze({
        installationId: binding.installationId,
        providerId: binding.providerId,
        providerKey: binding.providerKey,
        slot,
    });
}
const COMMON_KEYS = [
    'providerKey',
    'installationId',
    'providerId',
    'kind',
    'credentialSchema',
    'identityRevision',
    'updatedAt',
];
function parseCommon(item) {
    return {
        providerKey: text(item.providerKey),
        installationId: text(item.installationId),
        providerId: text(item.providerId),
        credentialSchema: integer(item.credentialSchema),
        identityRevision: integer(item.identityRevision),
        updatedAt: integer(item.updatedAt),
    };
}
function parsePrivate(item) {
    const hash = text(item.identityHash);
    if (!HASH.test(hash))
        invalid();
    const accountMasked = maskedAccount(item.accountMasked);
    const namespace = item.namespaceHash === undefined ? undefined : text(item.namespaceHash);
    if (namespace !== undefined && !HASH.test(namespace))
        invalid();
    return {
        identityHash: hash,
        ...(namespace ? { namespaceHash: namespace } : {}),
        ...(accountMasked === undefined ? {} : { accountMasked }),
    };
}
function parseBinding(value) {
    const kind = plainRecord(value).kind;
    if (typeof kind !== 'string' || !KINDS.has(kind))
        invalid();
    if (kind === 'public') {
        const item = record(value, COMMON_KEYS);
        return Object.freeze({ ...parseCommon(item), kind: 'public' });
    }
    if (kind === 'borrowed-current') {
        const item = record(value, [
            ...COMMON_KEYS,
            'identityHash',
            'namespaceHash',
            'accountMasked',
            'sourceRef',
        ]);
        const common = parseCommon(item);
        const sourceRef = captureSourceRef(item.sourceRef);
        if (sourceRef.installationId !== common.installationId)
            invalid();
        return Object.freeze({
            ...common,
            ...parsePrivate(item),
            kind: 'borrowed-current',
            sourceRef,
        });
    }
    const item = record(value, [
        ...COMMON_KEYS,
        'identityHash',
        'namespaceHash',
        'accountMasked',
        'slot',
    ]);
    return Object.freeze({
        ...parseCommon(item),
        ...parsePrivate(item),
        kind: 'direct-owned',
        ...(item.slot === undefined ? {} : { slot: slotName(item.slot) }),
    });
}
/** Read own data descriptors, never user iterators or index getters. */
function captureArray(value, maximum, parse) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
        invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = arrayLength(value, descriptors, maximum);
    const result = [];
    for (let index = 0; index < length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
            invalid();
        result.push(parse(descriptor.value));
    }
    return result;
}
/** A dense array's own length (no extra own keys such as a custom iterator). */
function arrayLength(value, descriptors, maximum) {
    const length = descriptors.length?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum)
        invalid();
    if (Reflect.ownKeys(value).length !== length + 1)
        invalid();
    return length;
}
/** The persisted credential state (schema 2): one record per providerKey. */
export function parseCredentialState(value) {
    if (value === undefined)
        return { bindings: [] };
    const item = record(value, ['version', 'bindings']);
    if (item.version !== CREDENTIAL_STATE_VERSION)
        invalid();
    const bindings = captureArray(item.bindings, 512, parseBinding);
    if (new Set(bindings.map((binding) => binding.providerKey)).size !== bindings.length)
        invalid();
    return { bindings: Object.freeze(bindings) };
}
export function serializeCredentialState(state) {
    return { version: CREDENTIAL_STATE_VERSION, bindings: state.bindings };
}
/**
 * A pre-release (schema 1) state: bindings with revisions, a garbage list of keychain slots.
 * It is not migrated; the caller treats it as empty and removes the slots it names.
 */
export function legacyCredentialSlots(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const item = value;
    if (item.version !== undefined || !Array.isArray(item.bindings))
        return undefined;
    const slots = [];
    const add = (candidate) => {
        if (!candidate || typeof candidate !== 'object')
            return;
        const slot = candidate;
        if (typeof slot.installationId === 'string' &&
            typeof slot.providerId === 'string' &&
            typeof slot.bindingRef === 'string' &&
            typeof slot.slotId === 'string' &&
            Number.isSafeInteger(slot.chunks) &&
            slot.chunks >= 1 &&
            slot.chunks <= MAX_SECRET_BYTES / SECRET_CHUNK_BYTES)
            slots.push({
                installationId: slot.installationId,
                providerId: slot.providerId,
                bindingRef: slot.bindingRef,
                slotId: slot.slotId,
                chunks: slot.chunks,
            });
    };
    for (const binding of item.bindings)
        add(binding?.secret);
    if (Array.isArray(item.garbage))
        for (const slot of item.garbage)
            add(slot);
    return slots.slice(0, 1024);
}
/** Display-only masked account of a login/borrow identity; anything unexpected is dropped. */
export function displayAccountMasked(value) {
    const own = (target, key) => target && typeof target === 'object' && !Array.isArray(target)
        ? Object.getOwnPropertyDescriptor(target, key)?.value
        : undefined;
    try {
        return maskedAccount(own(own(value, 'identity'), 'accountMasked'));
    }
    catch {
        return undefined;
    }
}
export function namespaceHash(identity) {
    return digest(JSON.stringify([
        text(identity.providerId),
        namespaceText(identity.region),
        namespaceText(identity.tenant),
    ]));
}
export function identityHash(identity) {
    return digest(JSON.stringify([
        text(identity.providerId),
        namespaceText(identity.region),
        namespaceText(identity.tenant),
        text(identity.subject),
    ]));
}
/** Commit request fields shared by every kind; anything unexpected fails closed. */
export function captureCommit(input) {
    if (!(input.signal instanceof AbortSignal))
        throw new ModelAccessCredentialError('credential_invalid');
    try {
        return {
            providerKey: text(input.providerKey),
            installationId: text(input.installationId),
            providerId: text(input.providerId),
            credentialSchema: integer(input.credentialSchema),
            signal: input.signal,
        };
    }
    catch {
        throw new ModelAccessCredentialError('credential_invalid');
    }
}
export function capturePayload(value) {
    if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_SECRET_BYTES - 2048)
        throw new ModelAccessCredentialError('credential_invalid');
    return value;
}
export function captureCommitIdentity(value, providerId) {
    try {
        return captureIdentity(value, providerId);
    }
    catch {
        throw new ModelAccessCredentialError('credential_invalid');
    }
}
export function captureAccountMasked(value) {
    try {
        return maskedAccount(value);
    }
    catch {
        throw new ModelAccessCredentialError('credential_invalid');
    }
}
/** identityRevision of the next commit on a key: always +1 (a re-login is a new identity epoch). */
export function nextIdentityRevision(previous) {
    return (previous?.identityRevision ?? 0) + 1;
}
//# sourceMappingURL=credential-state.js.map