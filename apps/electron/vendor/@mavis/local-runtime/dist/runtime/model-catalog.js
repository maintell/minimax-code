import { getModel } from '@earendil-works/pi-ai';
const FALLBACK_MODEL_LIMITS = {
    contextWindow: 200_000,
    maxTokens: 128_000,
};
export function lookupLocalCatalogModel(provider, modelId) {
    return getModel(provider, modelId);
}
export function lookupLocalModelLimits(provider, modelId) {
    const entry = lookupLocalCatalogModel(provider, modelId);
    if (!entry) {
        return { ...FALLBACK_MODEL_LIMITS, fromCatalog: false };
    }
    const contextWindow = typeof entry.contextWindow === 'number' && entry.contextWindow > 0
        ? entry.contextWindow
        : FALLBACK_MODEL_LIMITS.contextWindow;
    const maxTokens = typeof entry.maxTokens === 'number' && entry.maxTokens > 0
        ? entry.maxTokens
        : FALLBACK_MODEL_LIMITS.maxTokens;
    const api = typeof entry.api === 'string' ? entry.api : undefined;
    const baseUrl = typeof entry.baseUrl === 'string' ? entry.baseUrl : undefined;
    return {
        contextWindow,
        maxTokens,
        fromCatalog: true,
        ...(api ? { api } : {}),
        ...(baseUrl ? { baseUrl } : {}),
    };
}
//# sourceMappingURL=model-catalog.js.map