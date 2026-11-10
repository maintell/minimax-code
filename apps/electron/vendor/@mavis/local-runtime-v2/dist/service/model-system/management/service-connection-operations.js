import { MINIMAX_API_PROVIDER_ID, parseProviderId } from '../resolution/model-key.js';
import { MANAGED_MINIMAX_PROVIDER_ID } from '../identity.js';
import { customProviderKind } from '../catalog/list-models.js';
import { ModelProviderServiceContext } from './service-context.js';
import { LocalModelProviderError, } from '../contracts.js';
import { enqueueProviderMutation, requireCacheStatusView } from './service-helpers.js';
import { savedProviderKeyLabel } from '../byok-keys/operations.js';
import { assertModelAccessSelectable, modelAccessProviderKey, refreshModelAccessCatalog, manualAccessModel, testModelAccessProvider, } from '../model-access/operations.js';
import { isModelAccessProvider } from '../model-access/projection.js';
export async function testProvider(context, providerId, opts) {
    const accessKey = modelAccessProviderKey(context.deps.modelAccess, providerId);
    if (accessKey) {
        if (opts?.apiKeyOverride !== undefined)
            throw new LocalModelProviderError(400, 'Extension binding credentials cannot be overridden', 'MODEL_ACCESS_READ_ONLY');
        return testAccess(context, accessKey, undefined, opts);
    }
    if (parseProviderId(providerId)?.source === 'minimax_api') {
        return enqueueProviderMutation(context.minimaxMutationKey(), () => testProviderNow(context, providerId, opts));
    }
    return testProviderNow(context, providerId, opts);
}
async function testProviderNow(context, providerId, opts) {
    const target = context.resolveTestTarget(providerId, undefined, {
        ...(opts?.apiKeyOverride ? { apiKeyOverride: opts.apiKeyOverride } : {}),
    });
    const result = await context.testResolvedTarget(target);
    const entry = context.toCacheEntry(result, target.fingerprint);
    await context.deps.cache.setProviderStatus(target.cacheKey, entry);
    const keyLabel = opts?.apiKeyOverride ? undefined : savedProviderKeyLabel(context, providerId);
    return {
        ok: result.ok,
        status: requireCacheStatusView(entry),
        ...(keyLabel ? { keyLabel } : {}),
    };
}
export async function testModel(context, providerId, modelId, options) {
    const accessKey = modelAccessProviderKey(context.deps.modelAccess, providerId);
    if (accessKey)
        return testAccess(context, accessKey, modelId, options);
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
    const keyLabel = savedProviderKeyLabel(context, providerId);
    return {
        ok: result.ok,
        status: requireCacheStatusView(entry),
        ...(keyLabel ? { keyLabel } : {}),
    };
}
export async function discoverModels(context, providerId, options) {
    const accessKey = modelAccessProviderKey(context.deps.modelAccess, providerId);
    if (accessKey && context.deps.modelAccess) {
        return refreshModelAccessCatalog({
            access: context.deps.modelAccess,
            configGetter: context.deps.configGetter,
            updateByokConfig: context.deps.updateByokConfig,
        }, accessKey, options?.modelAccess);
    }
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
async function testAccess(context, providerKey, modelId, options) {
    if (!context.deps.modelAccess)
        throw new LocalModelProviderError(503, 'Model access unavailable', 'MODEL_ACCESS_UNAVAILABLE');
    // A model added by hand is not in the extension's list; the committed entry says how to ask.
    const committed = modelId
        ? context.deps.modelAccess.catalog?.(providerKey)?.[modelId]
        : undefined;
    const manual = modelId ? manualAccessModel(modelId, committed) : undefined;
    const result = await testModelAccessProvider(context.deps.modelAccess, providerKey, modelId, {
        ...options?.modelAccess,
        ...(manual ? { manual } : {}),
    });
    const keyLabel = modelAccessAccountLabel(context, providerKey);
    return {
        ok: result.ok,
        status: requireCacheStatusView(context.toCacheEntry(result, 'model-access')),
        ...(keyLabel ? { keyLabel } : {}),
    };
}
/** The masked account the extension reported for this binding; never a credential. */
function modelAccessAccountLabel(context, providerKey) {
    try {
        return context.deps.modelAccess?.bindings?.peek(providerKey)?.accountMasked;
    }
    catch {
        return undefined;
    }
}
export function assertModelSelectable(context, providerId, modelId) {
    const config = context.deps.configGetter();
    if (providerId === MANAGED_MINIMAX_PROVIDER_ID &&
        config.minimaxModelSource === 'minimax_api_key') {
        context.resolveTestTarget(MINIMAX_API_PROVIDER_ID, modelId);
        return;
    }
    const parsed = parseProviderId(providerId);
    if (parsed?.source === 'custom_provider') {
        const provider = config.custom_provider?.[parsed.providerKey];
        if (provider && assertNonKeyProviderSelectable(context, parsed.providerKey, provider, modelId))
            return;
    }
    if (parsed?.source !== 'custom_provider' && parsed?.source !== 'minimax_api')
        return;
    context.resolveTestTarget(providerId, modelId);
}
/** Providers that never route via a stored key; true when the check is complete. */
function assertNonKeyProviderSelectable(context, providerKey, provider, modelId) {
    // Extension providers route only through their binding; never via stored credentials.
    if (isModelAccessProvider(provider)) {
        assertModelAccessSelectable(context.deps.modelAccess, providerKey, provider, modelId);
        return true;
    }
    return customProviderKind(provider) === 'oauth';
}
//# sourceMappingURL=service-connection-operations.js.map