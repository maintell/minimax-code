import { CUSTOM_PROVIDER_ID_PREFIX, formatModelKey } from '../resolution/model-key.js';
import { resolveProviderCredential } from '@mavis/config';
import { normalizeProviderIdentityBaseUrl, isApiKeyProvider } from '../provider-identity.js';
import { LocalModelProviderError, } from '../contracts.js';
import { modelConfigFingerprint } from '../catalog/model-cache.js';
import { isModelAccessProvider } from '../model-access/projection.js';
import { ModelProviderServiceContext, } from './service-context.js';
import { modelParametersMatch, modelAccessProviderReadOnlyError, patchModelParameters, removeLegacyCustomProviderNpm, resetUnavailableCustomDefaultModel, requireCacheStatusView, } from './service-helpers.js';
import { modelsFromInputs } from './service-input.js';
import { readApiKeys } from '../byok-keys/key-list.js';
import { byokTestKeyLabel, forgetDroppedApiKeys } from '../byok-keys/operations.js';
export async function testUserModelCandidate(context, candidate, modelId) {
    const resolved = context.resolveUserProviderCandidate(candidate);
    const target = context.resolveTestTarget(resolved.providerId, modelId, {
        customProviderOverride: resolved.provider,
    });
    const result = await context.testResolvedTarget(target);
    const keyLabel = byokTestKeyLabel(resolved.provider);
    return {
        ok: result.ok,
        status: requireCacheStatusView(context.toCacheEntry(result, target.fingerprint)),
        ...(keyLabel ? { keyLabel } : {}),
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
    if (input.apiImport) {
        resolved.provider.options = {
            ...resolved.provider.options,
            modelAccessImport: { kind: 'imported-api', ...input.apiImport },
        };
    }
    const modelId = input.modelId?.trim();
    const test = await prepareCandidateTest(context, resolved, input, modelId);
    if (test.failed)
        return { ok: false, status: requirePreparedCandidateStatus(test) };
    const commit = {
        candidateCacheWritten: false,
    };
    const transaction = { resolved, input, modelId, test, commit };
    const keysBefore = readApiKeys(context.deps.configGetter().custom_provider?.[resolved.providerKey]);
    try {
        await persistCandidate(context, transaction);
    }
    catch (error) {
        await restoreCandidateAfterFailure(context, transaction, error);
    }
    throwCandidateCommitError(commit.blocked, input.skipConnectionTest === true);
    if (!transaction.existingProviderId)
        forgetDroppedApiKeys(context, resolved.providerKey, keysBefore);
    return {
        ok: true,
        ...(test.status ? { status: test.status } : {}),
        ...(input.skipConnectionTest ? { skippedTest: true } : {}),
        provider: context.requireCustomProviderView(transaction.existingProviderId ?? resolved.providerKey),
    };
}
async function prepareCandidateTest(context, resolved, input, modelId) {
    if (input.skipConnectionTest)
        return { failed: false };
    if (!modelId) {
        throw new LocalModelProviderError(400, 'model_id is required when running a connection test', 'VALIDATION_ERROR');
    }
    const target = context.resolveTestTarget(resolved.providerId, modelId, {
        customProviderOverride: resolved.provider,
    });
    const result = await context.testResolvedTarget(target);
    const entry = context.toCacheEntry(result, target.fingerprint);
    return {
        target,
        entry,
        status: requireCacheStatusView(entry),
        failed: !result.ok,
    };
}
function requirePreparedCandidateStatus(test) {
    if (test.status)
        return test.status;
    throw new LocalModelProviderError(500, 'Failed to normalize the model connection test result', 'TEST_STATUS_INVALID');
}
async function persistCandidate(context, transaction) {
    await context.deps.updateByokConfig(async (draft, currentConfig) => {
        transaction.input.beforeCommit?.();
        const tree = (draft.custom_provider ?? {});
        if (transaction.input.importIfExisting) {
            const existingProviderId = transaction.input.apiImport
                ? findExactApiImport(context, currentConfig, transaction.input.candidate)
                : findMatchingByokProvider(currentConfig, transaction.input.candidate);
            if (existingProviderId) {
                transaction.existingProviderId = existingProviderId;
                return;
            }
        }
        if (candidateRevisionChanged(transaction.resolved, tree, currentConfig)) {
            transaction.commit.blocked = 'config_changed';
            return;
        }
        if (!(await persistCandidateCache(context, transaction)))
            return;
        transaction.input.beforeCommit?.();
        tree[transaction.resolved.providerKey] = transaction.resolved.provider;
        draft.custom_provider = tree;
        activateSavedCandidate(draft, transaction);
        resetUnavailableCustomDefaultModel(draft, currentConfig);
    }, transaction.input.beforeCommit);
}
function apiImportIdentity(api, baseUrl, key, headers) {
    return JSON.stringify([
        api,
        normalizeProviderIdentityBaseUrl(baseUrl ?? ''),
        key,
        Object.entries(headers ?? {})
            .map(([name, value]) => [name.toLowerCase(), value])
            .sort(([a], [b]) => a.localeCompare(b)),
    ]);
}
function findExactApiImport(context, config, candidate) {
    const identity = apiImportIdentity(candidate.apiFormat, candidate.baseUrl, candidate.apiKey, candidate.headers);
    for (const [id, provider] of Object.entries(config.custom_provider ?? {})) {
        if (!isApiKeyProvider(provider) || context.deps.modelAccess?.requests.owns(id))
            continue;
        if (apiImportIdentity(provider.api, provider.options?.baseURL, provider.options?.apiKey, provider.options?.headers) === identity)
            return id;
    }
    return undefined;
}
function findMatchingByokProvider(config, candidate) {
    const key = candidate.apiKey?.trim();
    const baseUrl = normalizeProviderIdentityBaseUrl(candidate.baseUrl);
    if (!key || !baseUrl)
        return undefined;
    for (const [id, provider] of Object.entries(config.custom_provider ?? {})) {
        if (!isApiKeyProvider(provider))
            continue;
        let providerKey;
        try {
            providerKey = resolveProviderCredential({
                field: 'custom_provider options.apiKey',
                provider: id,
                value: provider.options?.apiKey,
            })?.trim();
        }
        catch {
            continue;
        }
        if (providerKey === key &&
            provider.options?.baseURL &&
            normalizeProviderIdentityBaseUrl(provider.options.baseURL) === baseUrl)
            return id;
    }
    return undefined;
}
function candidateRevisionChanged(resolved, tree, currentConfig) {
    // `draft` comes directly from YAML and can omit loader defaults. Compare an
    // existing provider against the normalized config while keeping the raw tree
    // as the value written back to disk.
    if (!resolved.expectedRevision)
        return tree[resolved.providerKey] !== undefined;
    const latest = currentConfig.custom_provider?.[resolved.providerKey];
    return !latest || modelConfigFingerprint(latest) !== resolved.expectedRevision;
}
async function persistCandidateCache(context, transaction) {
    const { entry, target } = transaction.test;
    if (!entry || !target)
        return true;
    try {
        transaction.commit.previousCacheEntry = await context.deps.cache.replaceModelStatus(target.cacheKey, entry);
        transaction.commit.candidateCacheWritten = true;
        return true;
    }
    catch {
        transaction.commit.blocked = 'cache_write_failed';
        return false;
    }
}
function activateSavedCandidate(draft, transaction) {
    if (!transaction.input.saveAndUse || transaction.input.skipConnectionTest)
        return;
    if (!transaction.modelId)
        return;
    draft.defaultModel = formatModelKey(transaction.resolved.providerId, transaction.modelId);
    draft.defaultModelVariant = undefined;
}
async function restoreCandidateAfterFailure(context, transaction, error) {
    const { entry, target } = transaction.test;
    if (entry && target) {
        return context.restoreCandidateCache(target.cacheKey, entry, transaction.commit, error);
    }
    throw error;
}
function throwCandidateCommitError(blocked, skippedConnectionTest) {
    if (blocked === 'config_changed') {
        const message = skippedConnectionTest
            ? 'Provider changed while the candidate was being saved'
            : 'Provider changed while the connection test was running';
        throw new LocalModelProviderError(409, message, 'CONFIG_CHANGED');
    }
    if (blocked === 'cache_write_failed') {
        throw new LocalModelProviderError(500, 'Failed to persist the successful model connection test', 'CACHE_WRITE_FAILED');
    }
}
export async function updateUserModelParameters(context, input) {
    const prepared = prepareModelParameterUpdate(context, input);
    const result = await context.deps.tester.test(`${prepared.target.cacheKey}@${prepared.target.fingerprint}`, prepared.target.target);
    const entry = context.toCacheEntry(result, prepared.target.fingerprint);
    if (!result.ok)
        return { ok: false, status: requireCacheStatusView(entry) };
    const commit = { candidateCacheWritten: false };
    try {
        await persistModelParameterUpdate(context, prepared, entry, commit);
    }
    catch (error) {
        await restoreModelParameterCache(context, {
            target: prepared.target,
            entry,
            commit,
            error,
        });
    }
    throwModelParameterCommitError(commit.blocked);
    return { ok: true, status: requireCacheStatusView(entry) };
}
function prepareModelParameterUpdate(context, input) {
    const providerKey = context.requireExistingProviderKey(input.providerId);
    const providerId = `${CUSTOM_PROVIDER_ID_PREFIX}${providerKey}`;
    const currentProvider = context.deps.configGetter().custom_provider?.[providerKey];
    if (!currentProvider) {
        throw new LocalModelProviderError(404, 'Model provider not found', 'PROVIDER_NOT_FOUND');
    }
    // Limits come from the extension catalog; a user override would not reach its transport.
    if (isModelAccessProvider(currentProvider))
        throw modelAccessProviderReadOnlyError();
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
    const target = context.resolveTestTarget(providerId, modelId, {
        customProviderOverride: candidateProvider,
    });
    return {
        providerKey,
        modelId,
        currentProvider,
        normalizedPatch,
        baselineFingerprint,
        target,
    };
}
async function persistModelParameterUpdate(context, prepared, entry, commit) {
    await context.deps.updateByokConfig(async (draft) => {
        const tree = (draft.custom_provider ?? {});
        const latestProvider = tree[prepared.providerKey];
        if (!latestProvider ||
            modelConfigFingerprint(latestProvider) !== prepared.baselineFingerprint) {
            commit.blocked = 'config_changed';
            return;
        }
        const latestModel = latestProvider.models?.[prepared.modelId];
        if (!latestModel) {
            commit.blocked = 'model_missing';
            return;
        }
        if (!(await persistModelParameterCache(context, prepared.target, entry, commit)))
            return;
        latestProvider.models = {
            ...latestProvider.models,
            [prepared.modelId]: patchModelParameters(latestModel, prepared.normalizedPatch),
        };
        removeLegacyCustomProviderNpm(latestProvider);
        draft.custom_provider = tree;
    });
}
async function persistModelParameterCache(context, target, entry, commit) {
    try {
        // Persist the successful credential while the config file lock is held.
        // A cache failure leaves the active config untouched.
        commit.previousCacheEntry = await context.deps.cache.replaceModelStatus(target.cacheKey, entry);
        commit.candidateCacheWritten = true;
        return true;
    }
    catch {
        commit.blocked = 'cache_write_failed';
        return false;
    }
}
async function restoreModelParameterCache(context, rollback) {
    if (rollback.commit.candidateCacheWritten) {
        try {
            await context.deps.cache.restoreModelStatusIfCurrent(rollback.target.cacheKey, rollback.entry, rollback.commit.previousCacheEntry);
        }
        catch {
            throw new LocalModelProviderError(500, 'Failed to restore model test status after the config write failed', 'CACHE_ROLLBACK_FAILED');
        }
    }
    throw rollback.error;
}
function throwModelParameterCommitError(blocked) {
    if (blocked === 'config_changed') {
        throw new LocalModelProviderError(409, 'Provider changed while the connection test was running', 'CONFIG_CHANGED');
    }
    if (blocked === 'model_missing') {
        throw new LocalModelProviderError(404, 'Model not found', 'MODEL_NOT_FOUND');
    }
    if (blocked === 'cache_write_failed') {
        throw new LocalModelProviderError(500, 'Failed to persist the successful model connection test', 'CACHE_WRITE_FAILED');
    }
}
//# sourceMappingURL=service-candidate-operations.js.map