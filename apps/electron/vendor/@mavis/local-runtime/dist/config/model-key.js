// Source-aware model key parsing for BYOK provider sources.
//
// Model keys keep the legacy `providerId/modelId` shape; the providerId part
// encodes which config tree the provider lives in:
//
//   'minimax/MiniMax-M3'                    -> config.provider (builtin tree)
//   'minimax_api/MiniMax-M3'               -> config.minimax_api (user MiniMax API key)
//   'custom_provider:openai-work/gpt-4.1' -> config.custom_provider['openai-work']
//
// 'minimax_api' is a reserved provider id: it always resolves to the BYOK
// source and never falls back to the legacy provider map (config-side
// enforcement drops a hand-written `provider.minimax_api` entry at read time).
export const MINIMAX_API_PROVIDER_ID = 'minimax_api';
export const CUSTOM_PROVIDER_ID_PREFIX = 'custom_provider:';
export function parseProviderId(providerId) {
    if (typeof providerId !== 'string' || providerId.length === 0)
        return undefined;
    if (providerId === MINIMAX_API_PROVIDER_ID) {
        return { source: 'minimax_api', providerId, providerKey: MINIMAX_API_PROVIDER_ID };
    }
    if (providerId.startsWith(CUSTOM_PROVIDER_ID_PREFIX)) {
        const providerKey = providerId.slice(CUSTOM_PROVIDER_ID_PREFIX.length);
        if (!providerKey)
            return undefined;
        return { source: 'custom_provider', providerId, providerKey };
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