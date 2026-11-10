import { ModelAccessContractError } from '@minimax/model-access-sdk';
function invalid() {
    throw new ModelAccessContractError('invalid_handlers');
}
function object(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || !descriptors[key]?.enumerable || !('value' in descriptors[key]))
            invalid();
    }
    return value;
}
function exact(value, expected) {
    const result = object(value);
    const actual = Object.keys(result);
    if (actual.length !== expected.length || actual.some((key) => !expected.includes(key)))
        invalid();
    return result;
}
/** Snapshot references, not the caller's mutable tables; inspection never invokes a handler. */
function methods(value, required, optional = []) {
    const result = object(value);
    const keys = Object.keys(result);
    if (required.some((key) => !Object.hasOwn(result, key)))
        invalid();
    if (keys.some((key) => (!required.includes(key) && !optional.includes(key)) || typeof result[key] !== 'function'))
        invalid();
    // Every key was checked above to be an allowed own function property.
    return Object.freeze({ ...result });
}
function providerHandlers(manifest, providers) {
    const result = Object.create(null);
    for (const provider of manifest.providers) {
        const owned = provider.credentialKinds.includes('direct-owned');
        result[provider.id] = methods(providers[provider.id], ['models', 'bindTransport', 'classifyError', ...(owned ? ['resolveOwned'] : [])], ['usage', ...(owned ? ['renewOwned', 'forceRenewOwned', 'forget'] : [])]);
    }
    return result;
}
function sourceHandlers(source, value) {
    const handlers = exact(value, Object.keys(source.capabilities));
    const parsed = Object.create(null);
    const groups = [
        {
            capability: 'login',
            entries: source.capabilities.login?.methods,
            required: ['begin'],
            optional: [],
        },
        {
            capability: 'subscriptionBorrow',
            entries: source.capabilities.subscriptionBorrow?.variants,
            required: ['discover', 'resolve'],
            optional: ['renew', 'forceRenew'],
        },
        {
            capability: 'apiKeyScan',
            entries: source.capabilities.apiKeyScan?.readers,
            required: ['scan'],
            optional: [],
        },
    ];
    for (const group of groups) {
        if (!group.entries)
            continue;
        const table = exact(handlers[group.capability], group.entries.map((entry) => entry.id));
        const saved = Object.create(null);
        for (const entry of group.entries)
            saved[entry.id] = methods(table[entry.id], group.required, group.optional);
        parsed[group.capability] = Object.freeze(saved);
    }
    return Object.freeze(parsed);
}
/** Registration must exactly match the static declaration, including method/variant/reader IDs. */
export function validateModelAccessExtension(manifest, value) {
    return captureExtension(manifest, value);
}
function captureExtension(manifest, value) {
    const root = object(value);
    if (Object.keys(root).some((key) => !['providers', 'sources', 'dispose'].includes(key)))
        invalid();
    if (Object.hasOwn(root, 'dispose') && typeof root.dispose !== 'function')
        invalid();
    const providers = exact(root.providers, manifest.providers.map((provider) => provider.id));
    const sources = exact(root.sources, manifest.sources.map((source) => source.id));
    const parsedProviders = providerHandlers(manifest, providers);
    const parsedSources = Object.create(null);
    for (const source of manifest.sources)
        parsedSources[source.id] = sourceHandlers(source, sources[source.id]);
    return Object.freeze({
        providers: Object.freeze(parsedProviders),
        sources: Object.freeze(parsedSources),
        ...(root.dispose ? { dispose: root.dispose } : {}),
    });
}
export function validateHostModelAccessExtension(manifest, value) {
    return captureExtension(manifest, value);
}
//# sourceMappingURL=extension-validation.js.map