import { resolveProviderCredential } from '@mavis/config';
import { CUSTOM_PROVIDER_ID_PREFIX, MINIMAX_API_PROVIDER_ID, formatModelKey, parseProviderId, } from '../config/model-key.js';
import { modelConnectionTestFingerprint } from './config-fingerprint.js';
import { minimaxApiBaseUrl, minimaxApiModels } from './list-models.js';
import { modelConfigFingerprint } from './model-cache.js';
import { generateProviderKey } from './provider-key.js';
import { buildCustomProviderView } from './provider-views.js';
import { mergeProviderHeaders, normalizeProviderBaseUrl } from './provider-request.js';
import { mergeModelsFromInputs, normalizeApiFormat, applyProviderCredentialUpdate, normalizeProviderCredentialUpdate, normalizeHeaderNames, normalizeHeaders, removeHeaderCaseInsensitive, } from './service-input.js';
import { LocalModelProviderError, } from './service-contract.js';
import { customProviderKeyFromId, removeLegacyCustomProviderNpm } from './service-helpers.js';
import { isMiniMaxM3ModelId, normalizeModelThinkingEffortOptions, } from './thinking.js';
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
        const requestedProviderId = input.providerId?.trim();
        let providerKey;
        let current;
        let expectedRevision;
        if (requestedProviderId) {
            providerKey = this.requireExistingProviderKey(requestedProviderId);
            current = config.custom_provider?.[providerKey];
            expectedRevision = input.expectedRevision?.trim();
            if (!current || !expectedRevision || modelConfigFingerprint(current) !== expectedRevision) {
                throw new LocalModelProviderError(409, 'Provider configuration changed', 'CONFIG_CHANGED');
            }
        }
        else {
            providerKey = generateProviderKey({
                displayName: input.name?.trim(),
                existingKeys: Object.keys(config.custom_provider ?? {}),
                ...(this.deps.randomHex ? { randomHex: this.deps.randomHex } : {}),
            });
        }
        const baseUrl = input.baseUrl?.trim();
        if (!baseUrl) {
            throw new LocalModelProviderError(400, 'base_url must not be empty', 'VALIDATION_ERROR');
        }
        const credentialUpdate = normalizeProviderCredentialUpdate(input);
        const options = { ...(current?.options ?? {}), baseURL: baseUrl, authMode: 'api-key' };
        if (!current && credentialUpdate.kind !== 'set') {
            throw new LocalModelProviderError(400, 'API key must not be empty', 'INVALID_API_KEY');
        }
        applyProviderCredentialUpdate(options, credentialUpdate);
        const headers = input.headers !== undefined ? normalizeHeaders(input.headers) : undefined;
        const removeHeaders = normalizeHeaderNames(input.removeHeaders);
        if (input.headers !== undefined || removeHeaders.length > 0) {
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
        const apiFormat = input.apiFormat !== undefined ? normalizeApiFormat(input.apiFormat) : current?.api;
        const provider = {
            ...(current ?? {}),
            ...(input.name !== undefined ? { name: input.name.trim() } : {}),
            kind: current?.kind ?? 'custom',
            enabled: current?.enabled ?? true,
            ...(apiFormat ? { api: apiFormat } : {}),
            options,
            ...(input.models !== undefined
                ? { models: mergeModelsFromInputs(current?.models, input.models) }
                : current?.models
                    ? { models: current.models }
                    : {}),
        };
        if (!apiFormat)
            delete provider.api;
        removeLegacyCustomProviderNpm(provider);
        return {
            providerKey,
            providerId: `${CUSTOM_PROVIDER_ID_PREFIX}${providerKey}`,
            provider,
            ...(expectedRevision ? { expectedRevision } : {}),
        };
    }
    discoveryTargetForProvider(provider) {
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
            const failures = [];
            for (const mode of resolved.minimaxM3ThinkingModes) {
                const result = await this.deps.tester.test(`${dedupKey}@minimax-m3-thinking=${mode}`, {
                    ...resolved.target,
                    minimaxM3ThinkingMode: mode,
                });
                if (!result.ok)
                    failures.push({ mode, result });
            }
            if (failures.length === 0)
                return { ok: true };
            const firstFailure = failures[0];
            if (!firstFailure)
                return { ok: true };
            return {
                ok: false,
                ...(firstFailure.result.errorCode ? { errorCode: firstFailure.result.errorCode } : {}),
                errorMessage: failures
                    .map(({ mode, result }) => `MiniMax M3 Thinking ${JSON.stringify(mode)}: ${result.errorMessage || result.errorCode || 'Connection test failed'}`)
                    .join('; ')
                    .slice(0, 500),
            };
        }
        if (!resolved.effortOptions?.length) {
            return this.deps.tester.test(dedupKey, resolved.target);
        }
        const failures = [];
        for (const effort of resolved.effortOptions) {
            const result = await this.deps.tester.test(`${dedupKey}@effort=${encodeURIComponent(effort)}`, {
                ...resolved.target,
                effort,
            });
            if (!result.ok)
                failures.push({ effort, result });
        }
        if (failures.length === 0)
            return { ok: true };
        const firstFailure = failures[0];
        if (!firstFailure)
            return { ok: true };
        return {
            ok: false,
            ...(firstFailure.result.errorCode ? { errorCode: firstFailure.result.errorCode } : {}),
            errorMessage: failures
                .map(({ effort, result }) => `Think Effort ${JSON.stringify(effort)}: ${result.errorMessage || result.errorCode || 'Connection test failed'}`)
                .join('; ')
                .slice(0, 500),
        };
    }
    resolveTestTarget(providerId, modelId, apiKeyOverride, customProviderOverride, minimaxModelOverride) {
        const config = this.deps.configGetter();
        if (parseProviderId(providerId)?.source === 'minimax_api') {
            return this.resolveMinimaxTestTarget(config, modelId, apiKeyOverride, minimaxModelOverride);
        }
        const providerKey = customProviderOverride
            ? customProviderKeyFromId(providerId)
            : this.requireExistingProviderKey(providerId);
        const provider = customProviderOverride ?? config.custom_provider?.[providerKey];
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
        const modelIds = Object.keys(provider?.models ?? {});
        const chosenModelId = modelId ?? modelIds[0];
        if (!chosenModelId || (modelId && !modelIds.includes(modelId))) {
            throw new LocalModelProviderError(modelId ? 404 : 400, modelId ? 'Model not found' : 'Provider has no configured models', modelId ? 'MODEL_NOT_FOUND' : 'NO_MODELS');
        }
        const fullProviderId = `${CUSTOM_PROVIDER_ID_PREFIX}${providerKey}`;
        const api = normalizeApiFormat(provider?.api) ?? 'anthropic-messages';
        const model = provider?.models?.[chosenModelId];
        const effortOptions = normalizeModelThinkingEffortOptions(model?.thinking?.effortOptions);
        const headers = mergeProviderHeaders(provider?.options?.headers, model?.headers);
        const target = {
            api,
            baseUrl: normalizeProviderBaseUrl(api, baseUrl),
            apiKey,
            modelId: chosenModelId,
            ...(headers ? { headers } : {}),
        };
        return {
            cacheKey: modelId ? formatModelKey(fullProviderId, modelId) : fullProviderId,
            fingerprint: modelConnectionTestFingerprint(target, provider?.models?.[chosenModelId]),
            target,
            ...(effortOptions ? { effortOptions } : {}),
        };
    }
    resolveMinimaxTestTarget(config, modelId, apiKeyOverride, modelOverride) {
        const apiKey = apiKeyOverride?.trim() ||
            resolveProviderCredential({
                field: 'minimax_api.apiKey',
                provider: 'minimax_api',
                value: config.minimax_api?.apiKey,
            });
        if (!apiKey) {
            throw new LocalModelProviderError(400, 'MiniMax API key is not configured', 'NO_API_KEY');
        }
        const models = minimaxApiModels(config);
        const modelIds = Object.keys(models);
        const chosenModelId = modelId ?? modelIds[0];
        if (!chosenModelId || (modelId && !modelIds.includes(modelId))) {
            throw new LocalModelProviderError(404, 'Model not found', 'MODEL_NOT_FOUND');
        }
        const model = modelOverride ?? models[chosenModelId];
        const effortOptions = normalizeModelThinkingEffortOptions(model?.thinking?.effortOptions);
        const minimaxM3ThinkingModes = isMiniMaxM3ModelId(chosenModelId)
            ? ['on', 'off']
            : undefined;
        const target = {
            api: 'anthropic-messages',
            baseUrl: normalizeProviderBaseUrl('anthropic-messages', minimaxApiBaseUrl(config)),
            apiKey,
            modelId: chosenModelId,
        };
        return {
            cacheKey: modelId
                ? formatModelKey(MINIMAX_API_PROVIDER_ID, modelId)
                : MINIMAX_API_PROVIDER_ID,
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