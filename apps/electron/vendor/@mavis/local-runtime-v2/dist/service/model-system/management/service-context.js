import { resolveProviderCredential } from '@mavis/config';
import { CUSTOM_PROVIDER_ID_PREFIX, MINIMAX_API_PROVIDER_ID, formatModelKey, parseProviderId, } from '../resolution/model-key.js';
import { LocalModelProviderError, } from '../contracts.js';
import { modelConnectionTestFingerprint } from '../catalog/config-fingerprint.js';
import { minimaxApiBaseUrl, minimaxApiModels } from '../catalog/list-models.js';
import { modelConfigFingerprint } from '../catalog/model-cache.js';
import { generateProviderKey } from './provider-key.js';
import { buildCustomProviderView } from '../catalog/provider-views.js';
import { mergeProviderHeaders, normalizeProviderBaseUrl, } from '../connectivity/provider-request.js';
import { mergeModelsFromInputs, normalizeApiFormat, applyProviderCredentialUpdate, normalizeProviderCredentialUpdate, normalizeHeaderNames, normalizeHeaders, removeHeaderCaseInsensitive, } from './service-input.js';
import { customProviderKeyFromId, removeLegacyCustomProviderNpm } from './service-helpers.js';
import { isMiniMaxM3ModelId, normalizeModelThinkingEffortOptions, } from '../resolution/model-ref.js';
import { byokEffectiveOutputLimit } from '../resolution/model-resolver-byok.js';
function requireCandidateBaseUrl(value) {
    const baseUrl = value?.trim();
    if (!baseUrl) {
        throw new LocalModelProviderError(400, 'base_url must not be empty', 'VALIDATION_ERROR');
    }
    return baseUrl;
}
function candidateOptions(current, input, baseUrl) {
    const apiKeyUpdate = normalizeProviderCredentialUpdate(input);
    const options = { ...(current?.options ?? {}), baseURL: baseUrl, authMode: 'api-key' };
    // A new provider needs a credential it can actually use; an existing one
    // keeps whatever it already has when the request carries none. `keep` on an
    // edit is a no-op, not a missing-key error.
    if (!current && apiKeyUpdate.kind !== 'set') {
        throw new LocalModelProviderError(400, 'API key must not be empty', 'INVALID_API_KEY');
    }
    applyProviderCredentialUpdate(options, apiKeyUpdate);
    applyCandidateHeaderUpdates(options, current, input);
    return options;
}
function applyCandidateHeaderUpdates(options, current, input) {
    const removeHeaders = normalizeHeaderNames(input.removeHeaders);
    if (input.headers === undefined && removeHeaders.length === 0)
        return;
    const headers = input.headers === undefined ? undefined : normalizeHeaders(input.headers);
    const nextHeaders = { ...(current?.options?.headers ?? {}) };
    for (const name of removeHeaders)
        removeHeaderCaseInsensitive(nextHeaders, name);
    for (const [name, value] of Object.entries(headers ?? {})) {
        removeHeaderCaseInsensitive(nextHeaders, name);
        nextHeaders[name] = value;
    }
    if (Object.keys(nextHeaders).length > 0)
        options.headers = nextHeaders;
    else
        delete options.headers;
}
function candidateApiFormat(current, input) {
    return input.apiFormat === undefined ? current?.api : normalizeApiFormat(input.apiFormat);
}
function candidateModelFields(current, input, implicitCustomProviderThinking) {
    if (input.models !== undefined) {
        return {
            models: mergeModelsFromInputs(current?.models, input.models, implicitCustomProviderThinking),
        };
    }
    return current?.models ? { models: current.models } : {};
}
function minimaxThinkingTestCases(resolved, dedupKey) {
    return (resolved.minimaxM3ThinkingModes ?? []).map((mode) => ({
        dedupKey: `${dedupKey}@minimax-m3-thinking=${mode}`,
        label: `MiniMax M3 Thinking ${JSON.stringify(mode)}`,
        target: { ...resolved.target, minimaxM3ThinkingMode: mode },
    }));
}
function effortTestCases(resolved, dedupKey) {
    return (resolved.effortOptions ?? []).map((effort) => ({
        dedupKey: `${dedupKey}@effort=${encodeURIComponent(effort)}`,
        label: `Think Effort ${JSON.stringify(effort)}`,
        target: { ...resolved.target, effort },
    }));
}
async function runConnectionTestCases(tester, cases) {
    const failures = [];
    for (const testCase of cases) {
        const result = await tester.test(testCase.dedupKey, testCase.target);
        if (!result.ok)
            failures.push({ label: testCase.label, result });
    }
    const firstFailure = failures[0];
    if (!firstFailure)
        return { ok: true };
    return {
        ok: false,
        ...(firstFailure.result.errorCode ? { errorCode: firstFailure.result.errorCode } : {}),
        errorMessage: failures
            .map(({ label, result }) => `${label}: ${connectionTestFailureMessage(result)}`)
            .join('; ')
            .slice(0, 500),
    };
}
function connectionTestFailureMessage(result) {
    return result.errorMessage || result.errorCode || 'Connection test failed';
}
function requireCustomProviderCredentials(provider, apiKeyOverride, providerId) {
    // A request about to leave the machine must surface the resolver's own
    // diagnosis. The probe is the view's tool: it reports a broken reference as
    // "configured" and returns no secret, which would downgrade "environment
    // variable MAFIA_KEY is not set" to a generic missing key.
    const apiKey = apiKeyOverride?.trim() ||
        resolveProviderCredential({
            field: 'options.apiKey',
            provider: providerId,
            value: provider?.options?.apiKey,
        });
    if (!apiKey) {
        throw new LocalModelProviderError(400, 'Provider API key is not configured', 'NO_API_KEY');
    }
    const baseUrl = provider?.options?.baseURL?.trim();
    if (!baseUrl) {
        throw new LocalModelProviderError(400, 'Provider base_url is not configured', 'NO_BASE_URL');
    }
    return { apiKey, baseUrl };
}
function requireCustomProviderModelId(provider, requestedModelId) {
    const modelIds = Object.keys(provider?.models ?? {});
    const modelId = requestedModelId ?? modelIds[0];
    if (modelId && (!requestedModelId || modelIds.includes(requestedModelId)))
        return modelId;
    if (requestedModelId) {
        throw new LocalModelProviderError(404, 'Model not found', 'MODEL_NOT_FOUND');
    }
    throw new LocalModelProviderError(400, 'Provider has no configured models', 'NO_MODELS');
}
function requireMinimaxModelId(models, requestedModelId) {
    const modelId = requestedModelId ?? Object.keys(models)[0];
    if (modelId && (!requestedModelId || Object.hasOwn(models, requestedModelId)))
        return modelId;
    throw new LocalModelProviderError(404, 'Model not found', 'MODEL_NOT_FOUND');
}
function minimaxThinkingModes(modelId) {
    return isMiniMaxM3ModelId(modelId) ? ['on', 'off'] : undefined;
}
function providerTestCacheKey(providerId, modelId) {
    return modelId ? formatModelKey(providerId, modelId) : providerId;
}
export class ModelProviderServiceContext {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    minimaxMutationKey() {
        return `${this.deps.configGetter().dataDir}\u0000${MINIMAX_API_PROVIDER_ID}`;
    }
    resolveUserProviderCandidate(input) {
        const config = this.deps.configGetter();
        const identity = this.resolveCandidateIdentity(input, config);
        const baseUrl = requireCandidateBaseUrl(input.baseUrl);
        const options = candidateOptions(identity.current, input, baseUrl);
        const apiFormat = candidateApiFormat(identity.current, input);
        const provider = {
            ...(identity.current ?? {}),
            ...(input.name !== undefined ? { name: input.name.trim() } : {}),
            kind: identity.current?.kind ?? 'custom',
            enabled: identity.current?.enabled ?? true,
            ...(apiFormat ? { api: apiFormat } : {}),
            options,
            ...candidateModelFields(identity.current, input, this.deps.implicitCustomProviderThinking === true),
        };
        if (!apiFormat)
            delete provider.api;
        removeLegacyCustomProviderNpm(provider);
        return {
            providerKey: identity.providerKey,
            providerId: `${CUSTOM_PROVIDER_ID_PREFIX}${identity.providerKey}`,
            provider,
            ...(identity.expectedRevision ? { expectedRevision: identity.expectedRevision } : {}),
        };
    }
    resolveCandidateIdentity(input, config) {
        const requestedProviderId = input.providerId?.trim();
        if (!requestedProviderId) {
            return {
                providerKey: generateProviderKey({
                    displayName: input.name?.trim(),
                    existingKeys: Object.keys(config.custom_provider ?? {}),
                    ...(this.deps.randomHex ? { randomHex: this.deps.randomHex } : {}),
                }),
            };
        }
        const providerKey = this.requireExistingProviderKey(requestedProviderId);
        const current = config.custom_provider?.[providerKey];
        const expectedRevision = input.expectedRevision?.trim();
        if (!current || !expectedRevision || modelConfigFingerprint(current) !== expectedRevision) {
            throw new LocalModelProviderError(409, 'Provider configuration changed', 'CONFIG_CHANGED');
        }
        return { providerKey, current, expectedRevision };
    }
    discoveryTargetForProvider(provider) {
        // Discovery talks to the upstream, so it needs the same credential the turn
        // path uses. Reading the raw field sent a `${VAR}` literal as the key.
        const apiKey = resolveProviderCredential({
            field: 'options.apiKey',
            provider: provider.name ?? 'custom_provider',
            value: provider.options?.apiKey,
        });
        if (!apiKey) {
            throw new LocalModelProviderError(400, 'Provider API key is not configured', 'NO_API_KEY');
        }
        const baseUrl = provider.options?.baseURL?.trim();
        if (!baseUrl) {
            throw new LocalModelProviderError(400, 'Provider base_url is not configured', 'NO_BASE_URL');
        }
        return {
            api: normalizeApiFormat(provider.api) ?? 'anthropic-messages',
            baseUrl,
            apiKey,
            ...(provider.options?.headers ? { headers: provider.options.headers } : {}),
        };
    }
    async restoreCandidateCache(cacheKey, expectedCurrent, commit, originalError) {
        if (commit.candidateCacheWritten) {
            try {
                await this.deps.cache.restoreModelStatusIfCurrent(cacheKey, expectedCurrent, commit.previousCacheEntry);
            }
            catch {
                throw new LocalModelProviderError(500, 'Failed to restore model test status after the config write failed', 'CACHE_ROLLBACK_FAILED');
            }
        }
        throw originalError;
    }
    async testResolvedTarget(resolved) {
        const dedupKey = `${resolved.cacheKey}@${resolved.fingerprint}`;
        if (resolved.minimaxM3ThinkingModes?.length) {
            return runConnectionTestCases(this.deps.tester, minimaxThinkingTestCases(resolved, dedupKey));
        }
        if (resolved.effortOptions?.length) {
            return runConnectionTestCases(this.deps.tester, effortTestCases(resolved, dedupKey));
        }
        return this.deps.tester.test(dedupKey, resolved.target);
    }
    resolveTestTarget(providerId, modelId, options = {}) {
        const config = this.deps.configGetter();
        if (parseProviderId(providerId)?.source === 'minimax_api') {
            return this.resolveMinimaxTestTarget(config, modelId, {
                ...(options.apiKeyOverride ? { apiKeyOverride: options.apiKeyOverride } : {}),
                ...(options.minimaxModelOverride ? { modelOverride: options.minimaxModelOverride } : {}),
            });
        }
        return this.resolveCustomTestTarget(config, providerId, modelId, options);
    }
    resolveCustomTestTarget(config, providerId, modelId, options) {
        const providerKey = options.customProviderOverride
            ? customProviderKeyFromId(providerId)
            : this.requireExistingProviderKey(providerId);
        const provider = options.customProviderOverride ?? config.custom_provider?.[providerKey];
        const { apiKey, baseUrl } = requireCustomProviderCredentials(provider, options.apiKeyOverride, `${CUSTOM_PROVIDER_ID_PREFIX}${providerKey}`);
        const chosenModelId = requireCustomProviderModelId(provider, modelId);
        const fullProviderId = `${CUSTOM_PROVIDER_ID_PREFIX}${providerKey}`;
        const api = normalizeApiFormat(provider?.api) ?? 'anthropic-messages';
        const model = provider?.models?.[chosenModelId];
        const effortOptions = normalizeModelThinkingEffortOptions(model?.thinking?.effortOptions);
        const headers = mergeProviderHeaders(provider?.options?.headers, model?.headers);
        const outputLimit = byokEffectiveOutputLimit(model);
        const target = {
            api,
            baseUrl: normalizeProviderBaseUrl(api, baseUrl),
            apiKey,
            modelId: chosenModelId,
            ...(headers ? { headers } : {}),
            outputLimit,
        };
        return {
            cacheKey: providerTestCacheKey(fullProviderId, modelId),
            fingerprint: modelConnectionTestFingerprint(target, provider?.models?.[chosenModelId]),
            target,
            ...(effortOptions ? { effortOptions } : {}),
        };
    }
    resolveMinimaxTestTarget(config, modelId, options = {}) {
        const apiKey = options.apiKeyOverride?.trim() ||
            resolveProviderCredential({
                field: 'minimax_api.apiKey',
                provider: 'minimax_api',
                value: config.minimax_api?.apiKey,
            });
        if (!apiKey) {
            throw new LocalModelProviderError(400, 'MiniMax API key is not configured', 'NO_API_KEY');
        }
        const models = minimaxApiModels(config);
        const chosenModelId = requireMinimaxModelId(models, modelId);
        const model = options.modelOverride ?? models[chosenModelId];
        const effortOptions = normalizeModelThinkingEffortOptions(model?.thinking?.effortOptions);
        const minimaxM3ThinkingModes = minimaxThinkingModes(chosenModelId);
        const outputLimit = byokEffectiveOutputLimit(model);
        const target = {
            api: 'anthropic-messages',
            baseUrl: normalizeProviderBaseUrl('anthropic-messages', minimaxApiBaseUrl(config)),
            apiKey,
            modelId: chosenModelId,
            outputLimit,
        };
        return {
            cacheKey: providerTestCacheKey(MINIMAX_API_PROVIDER_ID, modelId),
            fingerprint: modelConnectionTestFingerprint(target, model),
            target,
            ...(minimaxM3ThinkingModes ? { minimaxM3ThinkingModes } : {}),
            ...(effortOptions ? { effortOptions } : {}),
        };
    }
    resolveDiscoveryTarget(providerId) {
        const providerKey = this.requireExistingProviderKey(providerId);
        const provider = this.deps.configGetter().custom_provider?.[providerKey];
        if (!provider) {
            throw new LocalModelProviderError(404, 'Model provider not found', 'PROVIDER_NOT_FOUND');
        }
        return this.discoveryTargetForProvider(provider);
    }
    toCacheEntry(result, fingerprint) {
        return {
            state: result.ok ? 'available' : 'failed',
            last_tested_at: (this.deps.now ?? Date.now)(),
            config_fingerprint: fingerprint,
            ...(result.errorCode ? { last_error_code: result.errorCode } : {}),
            ...(result.errorMessage ? { last_error_message: result.errorMessage } : {}),
        };
    }
    /** Accepts `custom_provider:<key>` or a bare key; 404 when not configured. */
    requireExistingProviderKey(providerId) {
        const parsed = parseProviderId(providerId);
        const providerKey = parsed?.source === 'custom_provider' ? parsed.providerKey : providerId?.trim();
        const exists = providerKey
            ? this.deps.configGetter().custom_provider?.[providerKey]
            : undefined;
        if (!providerKey || !exists) {
            throw new LocalModelProviderError(404, 'Model provider not found', 'PROVIDER_NOT_FOUND');
        }
        return providerKey;
    }
    requireCustomProviderView(providerKey) {
        const config = this.deps.configGetter();
        const provider = config.custom_provider?.[providerKey];
        if (!provider) {
            throw new LocalModelProviderError(404, 'Model provider not found', 'PROVIDER_NOT_FOUND');
        }
        return buildCustomProviderView(config, this.deps.cache.load(), providerKey, provider);
    }
}
//# sourceMappingURL=service-context.js.map