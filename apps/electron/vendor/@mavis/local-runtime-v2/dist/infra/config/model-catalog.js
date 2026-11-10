import { getModels, getProviders } from '@earendil-works/pi-ai';
const FALLBACK_MODEL_LIMITS = {
    contextWindow: 200_000,
    maxTokens: 128_000,
};
export const DEFAULT_LOCAL_PI_API = 'anthropic-messages';
export function lookupLocalModelLimits(provider, modelId) {
    const entry = lookupLocalCatalogModel(provider, modelId);
    if (!entry)
        return { ...FALLBACK_MODEL_LIMITS, fromCatalog: false };
    return {
        contextWindow: positive(entry.contextWindow) || FALLBACK_MODEL_LIMITS.contextWindow,
        maxTokens: positive(entry.maxTokens) || FALLBACK_MODEL_LIMITS.maxTokens,
        fromCatalog: true,
        ...(entry.api ? { api: entry.api } : {}),
        ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
    };
}
function lookupLocalCatalogModel(provider, modelId) {
    const knownProvider = getProviders().find((candidate) => candidate === provider);
    if (!knownProvider)
        return undefined;
    return getModels(knownProvider).find((model) => model.id === modelId);
}
function positive(value) {
    return typeof value === 'number' && value > 0 ? value : 0;
}
export { lookupLocalCatalogModel };
export { positive };
//# sourceMappingURL=model-catalog.js.map