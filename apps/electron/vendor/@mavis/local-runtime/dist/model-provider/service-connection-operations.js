import { MINIMAX_API_PROVIDER_ID, parseProviderId } from '../config/model-key.js';
import { LocalModelProviderError } from './service-contract.js';
import { enqueueProviderMutation, requireCacheStatusView } from './service-helpers.js';
export async function testProvider(context, providerId, opts) {
    if (parseProviderId(providerId)?.source === 'minimax_api') {
        return enqueueProviderMutation(context.minimaxMutationKey(), () => testProviderNow(context, providerId, opts));
    }
    return testProviderNow(context, providerId, opts);
}
async function testProviderNow(context, providerId, opts) {
    const target = context.resolveTestTarget(providerId, undefined, opts?.apiKeyOverride);
    const result = await context.testResolvedTarget(target);
    const entry = context.toCacheEntry(result, target.fingerprint);
    await context.deps.cache.setProviderStatus(target.cacheKey, entry);
    return { ok: result.ok, status: requireCacheStatusView(entry) };
}
export async function testModel(context, providerId, modelId) {
    if (parseProviderId(providerId)?.source === 'minimax_api') {
        return enqueueProviderMutation(context.minimaxMutationKey(), () => testModelNow(context, providerId, modelId));
    }
    return testModelNow(context, providerId, modelId);
}
async function testModelNow(context, providerId, modelId) {
    const target = context.resolveTestTarget(providerId, modelId);
    const result = await context.testResolvedTarget(target);
    const entry = context.toCacheEntry(result, target.fingerprint);
    await context.deps.cache.setModelStatus(target.cacheKey, entry);
    return { ok: result.ok, status: requireCacheStatusView(entry) };
}
export async function discoverModels(context, providerId) {
    const discoverer = context.deps.discoverer;
    if (!discoverer) {
        throw new LocalModelProviderError(503, 'Model discovery is not configured', 'MODEL_DISCOVERY_UNAVAILABLE');
    }
    const target = context.resolveDiscoveryTarget(providerId);
    const result = await discoverer.discover(target);
    if (!result.ok) {
        throw new LocalModelProviderError(502, result.errorMessage, result.errorCode);
    }
    return result.models;
}
export function assertModelSelectable(context, providerId, modelId) {
    if (providerId === 'minimax' &&
        context.deps.configGetter().minimaxModelSource === 'minimax_api_key') {
        context.resolveTestTarget(MINIMAX_API_PROVIDER_ID, modelId);
        return;
    }
    const parsed = parseProviderId(providerId);
    if (parsed?.source !== 'custom_provider' && parsed?.source !== 'minimax_api')
        return;
    context.resolveTestTarget(providerId, modelId);
}
//# sourceMappingURL=service-connection-operations.js.map