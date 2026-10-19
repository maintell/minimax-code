import { CUSTOM_PROVIDER_ID_PREFIX, formatModelKey } from '../config/model-key.js';
import { modelConfigFingerprint } from './model-cache.js';
import { LocalModelProviderError, } from './service-contract.js';
import { modelParametersMatch, patchModelParameters, removeLegacyCustomProviderNpm, resetUnavailableCustomDefaultModel, requireCacheStatusView, } from './service-helpers.js';
import { modelsFromInputs } from './service-input.js';
export async function testUserModelCandidate(context, candidate, modelId) {
    const resolved = context.resolveUserProviderCandidate(candidate);
    const target = context.resolveTestTarget(resolved.providerId, modelId, undefined, resolved.provider);
    const result = await context.testResolvedTarget(target);
    return {
        ok: result.ok,
        status: requireCacheStatusView(context.toCacheEntry(result, target.fingerprint)),
    };
}
export async function discoverUserModelsCandidate(context, candidate) {
    const discoverer = context.deps.discoverer;
    if (!discoverer) {
        throw new LocalModelProviderError(503, 'Model discovery is not configured', 'MODEL_DISCOVERY_UNAVAILABLE');
    }
    const resolved = context.resolveUserProviderCandidate(candidate);
    const result = await discoverer.discover(context.discoveryTargetForProvider(resolved.provider));
    if (!result.ok) {
        throw new LocalModelProviderError(502, result.errorMessage, result.errorCode);
    }
    return result.models;
}
export async function saveUserModelProviderCandidate(context, input) {
    const resolved = context.resolveUserProviderCandidate(input.candidate);
    const modelId = input.modelId?.trim();
    if (!input.skipConnectionTest && !modelId) {
        throw new LocalModelProviderError(400, 'model_id is required when running a connection test', 'VALIDATION_ERROR');
    }
    const target = !input.skipConnectionTest && modelId
        ? context.resolveTestTarget(resolved.providerId, modelId, undefined, resolved.provider)
        : undefined;
    const result = target ? await context.testResolvedTarget(target) : undefined;
    const entry = result && target ? context.toCacheEntry(result, target.fingerprint) : undefined;
    const status = entry ? requireCacheStatusView(entry) : undefined;
    if (result && !result.ok) {
        if (!status) {
            throw new LocalModelProviderError(500, 'Failed to normalize the model connection test result', 'TEST_STATUS_INVALID');
        }
        return { ok: false, status };
    }
    const commit = {
        blocked: undefined,
        candidateCacheWritten: false,
        previousCacheEntry: undefined,
    };
    try {
        await context.deps.updateByokConfig(async (draft, currentConfig) => {
            const tree = (draft.custom_provider ?? {});
            // `draft` comes directly from YAML so it can omit defaults that the
            // config loader adds. The revision returned to the UI is calculated
            // from that normalized config, so compare like with like here. The
            // raw tree remains the source that is eventually written to disk.
            const latest = currentConfig.custom_provider?.[resolved.providerKey];
            if (resolved.expectedRevision
                ? !latest || modelConfigFingerprint(latest) !== resolved.expectedRevision
                : tree[resolved.providerKey] !== undefined) {
                commit.blocked = 'config_changed';
                return;
            }
            if (entry) {
                try {
                    if (!target)
                        return;
                    commit.previousCacheEntry = await context.deps.cache.replaceModelStatus(target.cacheKey, entry);
                    commit.candidateCacheWritten = true;
                }
                catch {
                    commit.blocked = 'cache_write_failed';
                    return;
                }
            }
            tree[resolved.providerKey] = resolved.provider;
            draft.custom_provider = tree;
            if (input.saveAndUse && !input.skipConnectionTest && modelId) {
                draft.defaultModel = formatModelKey(resolved.providerId, modelId);
                draft.defaultModelVariant = undefined;
            }
            resetUnavailableCustomDefaultModel(draft);
        });
    }
    catch (error) {
        if (entry && target)
            await context.restoreCandidateCache(target.cacheKey, entry, commit, error);
        throw error;
    }
    if (commit.blocked === 'config_changed') {
        throw new LocalModelProviderError(409, input.skipConnectionTest
            ? 'Provider changed while the candidate was being saved'
            : 'Provider changed while the connection test was running', 'CONFIG_CHANGED');
    }
    if (commit.blocked === 'cache_write_failed') {
        throw new LocalModelProviderError(500, 'Failed to persist the successful model connection test', 'CACHE_WRITE_FAILED');
    }
    return {
        ok: true,
        ...(status ? { status } : {}),
        ...(input.skipConnectionTest ? { skippedTest: true } : {}),
        provider: context.requireCustomProviderView(resolved.providerKey),
    };
}
export async function updateUserModelParameters(context, input) {
    const providerKey = context.requireExistingProviderKey(input.providerId);
    const providerId = `${CUSTOM_PROVIDER_ID_PREFIX}${providerKey}`;
    const currentProvider = context.deps.configGetter().custom_provider?.[providerKey];
    if (!currentProvider) {
        throw new LocalModelProviderError(404, 'Model provider not found', 'PROVIDER_NOT_FOUND');
    }
    const modelId = input.modelId?.trim();
    const currentModel = modelId ? currentProvider?.models?.[modelId] : undefined;
    if (!modelId || !currentModel) {
        throw new LocalModelProviderError(404, 'Model not found', 'MODEL_NOT_FOUND');
    }
    if (!modelParametersMatch(currentModel, input)) {
        throw new LocalModelProviderError(409, 'Model parameters changed before the update started', 'CONFIG_CHANGED');
    }
    const normalizedPatch = modelsFromInputs([
        {
            modelId,
            limit: { context: input.contextLimit, output: input.maxOutputTokens },
        },
    ])[modelId];
    if (!normalizedPatch) {
        throw new LocalModelProviderError(400, 'Model parameters are invalid', 'VALIDATION_ERROR');
    }
    const candidateModel = patchModelParameters(currentModel, normalizedPatch);
    const candidateProvider = {
        ...currentProvider,
        models: { ...currentProvider.models, [modelId]: candidateModel },
    };
    const baselineFingerprint = modelConfigFingerprint(currentProvider);
    const target = context.resolveTestTarget(providerId, modelId, undefined, candidateProvider);
    const result = await context.deps.tester.test(`${target.cacheKey}@${target.fingerprint}`, target.target);
    const entry = context.toCacheEntry(result, target.fingerprint);
    if (!result.ok)
        return { ok: false, status: requireCacheStatusView(entry) };
    const commit = {
        blocked: undefined,
        candidateCacheWritten: false,
        previousCacheEntry: undefined,
    };
    try {
        await context.deps.updateByokConfig(async (draft) => {
            const tree = (draft.custom_provider ?? {});
            const latestProvider = tree[providerKey];
            if (!latestProvider || modelConfigFingerprint(latestProvider) !== baselineFingerprint) {
                commit.blocked = 'config_changed';
                return;
            }
            const latestModel = latestProvider.models?.[modelId];
            if (!latestModel) {
                commit.blocked = 'model_missing';
                return;
            }
            try {
                // Persist the successful credential while the config file lock is held.
                // A cache failure leaves the active config untouched.
                commit.previousCacheEntry = await context.deps.cache.replaceModelStatus(target.cacheKey, entry);
                commit.candidateCacheWritten = true;
            }
            catch {
                commit.blocked = 'cache_write_failed';
                return;
            }
            latestProvider.models = {
                ...latestProvider.models,
                [modelId]: patchModelParameters(latestModel, normalizedPatch),
            };
            removeLegacyCustomProviderNpm(latestProvider);
            draft.custom_provider = tree;
        });
    }
    catch (error) {
        if (commit.candidateCacheWritten) {
            try {
                await context.deps.cache.restoreModelStatusIfCurrent(target.cacheKey, entry, commit.previousCacheEntry);
            }
            catch {
                throw new LocalModelProviderError(500, 'Failed to restore model test status after the config write failed', 'CACHE_ROLLBACK_FAILED');
            }
        }
        throw error;
    }
    if (commit.blocked === 'config_changed') {
        throw new LocalModelProviderError(409, 'Provider changed while the connection test was running', 'CONFIG_CHANGED');
    }
    if (commit.blocked === 'model_missing') {
        throw new LocalModelProviderError(404, 'Model not found', 'MODEL_NOT_FOUND');
    }
    if (commit.blocked === 'cache_write_failed') {
        throw new LocalModelProviderError(500, 'Failed to persist the successful model connection test', 'CACHE_WRITE_FAILED');
    }
    return { ok: true, status: requireCacheStatusView(entry) };
}
//# sourceMappingURL=service-candidate-operations.js.map