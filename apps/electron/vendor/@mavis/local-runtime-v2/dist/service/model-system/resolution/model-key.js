import { CUSTOM_PROVIDER_ID_PREFIX, MINIMAX_API_PROVIDER_ID, } from '../identity.js';
export { CUSTOM_PROVIDER_ID_PREFIX, MINIMAX_API_PROVIDER_ID } from '../identity.js';
export function parseProviderId(providerId) {
    if (!providerId)
        return undefined;
    if (providerId === MINIMAX_API_PROVIDER_ID) {
        return { source: 'minimax_api', providerId, providerKey: MINIMAX_API_PROVIDER_ID };
    }
    if (providerId.startsWith(CUSTOM_PROVIDER_ID_PREFIX)) {
        const providerKey = providerId.slice(CUSTOM_PROVIDER_ID_PREFIX.length);
        return providerKey ? { source: 'custom_provider', providerId, providerKey } : undefined;
    }
    return { source: 'provider', providerId, providerKey: providerId };
}
export function parseSourceQualifiedModelKey(raw) {
    if (typeof raw !== 'string')
        return undefined;
    const slash = raw.indexOf('/');
    if (slash <= 0 || slash === raw.length - 1)
        return undefined;
    const parsedProvider = parseProviderId(raw.slice(0, slash));
    if (!parsedProvider)
        return undefined;
    return { ...parsedProvider, modelId: raw.slice(slash + 1) };
}
export function formatModelKey(providerId, modelId) {
    return `${providerId}/${modelId}`;
}
//# sourceMappingURL=model-key.js.map