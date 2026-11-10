// Sanitized provider views for the three model sources. Everything returned
// from here is API-response-safe: keys appear as `maskedApiKey` for display
// API keys remain write-only across this boundary.
import { maskSecret } from '../secret.js';
import { CUSTOM_PROVIDER_ID_PREFIX, MINIMAX_API_PROVIDER_ID, formatModelKey, parseSourceQualifiedModelKey, } from '../resolution/model-key.js';
import { isModelAccessProvider, modelAccessProviderView } from '../model-access/projection.js';
import { isApiKeyProvider } from '../provider-identity.js';
import { maskApiKey, readApiKeys } from '../byok-keys/key-list.js';
import { sharedByokKeyPool } from '../byok-keys/key-pool.js';
import { probeProviderCredential } from '@mavis/config';
import { modelConnectionTestFingerprint } from './config-fingerprint.js';
import { MINIMAX_API_FORMAT, MINIMAX_API_PROVIDER_NAME, builtinProviderKind, buildModelEntry, cacheStatusView, customProviderKind, minimaxApiBaseUrl, minimaxApiModels, } from './list-models.js';
import { modelCacheStatusFor, modelConfigFingerprint, } from './model-cache.js';
import { mergeProviderHeaders, normalizeProviderBaseUrl, } from '../connectivity/provider-request.js';
/**
 * Credential state for a provider view. An environment reference counts as
 * configured even when the variable is unset right now, so the user sees what
 * is configured rather than a provider that flickers to keyless between runs.
 * The resolved value is masked like any other key; an unresolved reference has
 * no masked form to show, because masking the literal `${VAR}` would imply a
 * secret that is not there.
 */
function credentialViewFields(options, providerId) {
    const probe = probeProviderCredential({
        field: 'options.apiKey',
        provider: providerId,
        value: options?.apiKey,
    });
    if (!probe.configured)
        return { hasApiKey: false };
    return probe.secret
        ? { hasApiKey: true, maskedApiKey: maskSecret(probe.secret) }
        : { hasApiKey: true };
}
export function buildBuiltinProviderView(config, cache, providerId, provider) {
    const providerName = provider.name ?? providerId;
    const credential = credentialViewFields(provider.options, providerId);
    const providerKind = builtinProviderKind(config, providerId, provider);
    const models = providerId === 'minimax' && config.minimaxModelSource === 'minimax_api_key'
        ? minimaxApiModels(config)
        : (provider.models ?? {});
    return {
        providerId,
        name: providerName,
        source: 'provider',
        kind: providerKind,
        enabled: true,
        ...(provider.options?.baseURL ? { baseUrl: provider.options.baseURL } : {}),
        ...credential,
        models: providerModelEntries(config, cache, {
            providerId,
            models,
            providerSource: 'provider',
            providerKind,
            providerName,
            statusForModel: (modelId, model) => customModelStatus({ cache, providerId, provider, modelId, model }),
        }),
        ...(fingerprintedProviderStatus(cache, providerId, provider) ?? {}),
    };
}
export function buildMinimaxProviderView(config, cache) {
    const credential = credentialViewFields(config.minimax_api, MINIMAX_API_PROVIDER_ID);
    return {
        providerId: MINIMAX_API_PROVIDER_ID,
        name: MINIMAX_API_PROVIDER_NAME,
        source: 'minimax_api',
        kind: 'minimax-api-key',
        enabled: true,
        baseUrl: minimaxApiBaseUrl(config),
        apiFormat: MINIMAX_API_FORMAT,
        ...credential,
        models: providerModelEntries(config, cache, {
            providerId: MINIMAX_API_PROVIDER_ID,
            models: minimaxApiModels(config),
            providerSource: 'minimax_api',
            providerKind: 'minimax-api-key',
            providerName: MINIMAX_API_PROVIDER_NAME,
        }),
        ...(statusOf(cache, MINIMAX_API_PROVIDER_ID) ?? {}),
    };
}
export function buildCustomProviderView(config, cache, { providerKey, provider }, viewOptions = {}) {
    const providerId = `${CUSTOM_PROVIDER_ID_PREFIX}${providerKey}`;
    const providerName = provider.name ?? providerKey;
    const { modelAccess, credential } = externalAccessFields(providerKey, provider, viewOptions);
    const providerKind = customProviderKind(provider);
    return {
        providerId,
        name: providerName,
        source: 'custom_provider',
        kind: providerKind,
        enabled: provider.enabled !== false,
        ...(provider.options?.baseURL ? { baseUrl: provider.options.baseURL } : {}),
        ...(provider.api ? { apiFormat: provider.api } : {}),
        ...credential,
        ...(provider.options?.headers
            ? { headerNames: Object.keys(provider.options.headers).sort() }
            : {}),
        configRevision: modelConfigFingerprint(provider),
        models: providerModelEntries(config, cache, {
            providerId,
            models: provider.models ?? {},
            providerSource: 'custom_provider',
            providerKind,
            providerName,
            statusForModel: (modelId, model) => customModelStatus({ cache, providerId, provider, modelId, model }),
        }),
        ...(fingerprintedProviderStatus(cache, providerId, provider) ?? {}),
        ...(modelAccess ? { modelAccess } : {}),
    };
}
/** Extension-owned providers never own a stored key, even if a stray one exists. */
function externalAccessFields(providerKey, provider, viewOptions) {
    const providerId = `${CUSTOM_PROVIDER_ID_PREFIX}${providerKey}`;
    if (isModelAccessProvider(provider)) {
        return {
            modelAccess: modelAccessProviderView(provider, safeModelAccessBinding(providerKey, viewOptions)),
            credential: { hasApiKey: false },
        };
    }
    const keys = isApiKeyProvider(provider) ? readApiKeys(provider) : [];
    if (keys.length > 0) {
        const pool = viewOptions.byokKeyPool ?? sharedByokKeyPool();
        const first = keys.find((key) => key.enabled);
        return {
            credential: {
                // The first enabled key is the one `maskedApiKey` always meant.
                ...credentialViewFields(first ? { apiKey: first.key } : undefined, providerId),
                apiKeys: keys.map((key) => apiKeyView(pool, providerKey, key)),
            },
        };
    }
    return { credential: credentialViewFields(provider.options, providerId) };
}
function apiKeyView(pool, providerKey, key) {
    const rest = pool.rest(providerKey, key.id);
    const lastProbe = pool.lastProbe(providerKey, key.id);
    return {
        id: key.id,
        ...(key.name ? { name: key.name } : {}),
        masked: maskApiKey(key),
        enabled: key.enabled,
        ...(rest ? { rest } : {}),
        ...(lastProbe ? { lastProbe } : {}),
    };
}
function safeModelAccessBinding(providerKey, viewOptions) {
    try {
        return viewOptions.modelAccessBinding?.(providerKey);
    }
    catch {
        return undefined;
    }
}
function providerModelEntries(config, cache, input) {
    const selected = parseSourceQualifiedModelKey(config.defaultModel);
    return Object.entries(input.models).map(([modelId, model]) => buildModelEntry({
        providerId: input.providerId,
        modelId,
        model,
        selected: selected?.providerId === input.providerId && selected?.modelId === modelId,
        providerSource: input.providerSource,
        providerKind: input.providerKind,
        providerName: input.providerName,
        status: input.statusForModel
            ? input.statusForModel(modelId, model)
            : cache.model_status[formatModelKey(input.providerId, modelId)],
    }));
}
function customModelStatus(input) {
    const fingerprint = customModelFingerprint(input.provider, input.modelId, input.model);
    return fingerprint
        ? modelCacheStatusFor(input.cache, input.providerId, input.modelId, fingerprint)
        : undefined;
}
// A provider-level test runs against the provider's first model, so the cached
// provider status is only meaningful while that model's effective request
// configuration is unchanged. Editing base_url, api_key, headers or the api
// format must retire the cached verdict instead of leaving a stale green badge
// behind — the same rule the per-model entries already follow.
function fingerprintedProviderStatus(cache, providerId, provider) {
    const firstModel = Object.entries(provider.models ?? {})[0];
    if (!firstModel)
        return undefined;
    const fingerprint = customModelFingerprint(provider, firstModel[0], firstModel[1]);
    const entry = cache.provider_status[providerId];
    if (!fingerprint || entry?.config_fingerprint !== fingerprint)
        return undefined;
    const view = cacheStatusView(entry);
    return view ? { status: view } : undefined;
}
function customModelFingerprint(provider, modelId, model) {
    const apiKey = probeProviderCredential({
        field: 'options.apiKey',
        provider: provider.name ?? 'custom_provider',
        value: provider.options?.apiKey,
    }).secret;
    const baseUrl = provider.options?.baseURL?.trim();
    if (!apiKey || !baseUrl)
        return undefined;
    const api = (provider.api?.trim() || 'anthropic-messages');
    const headers = mergeProviderHeaders(provider.options?.headers, model.headers);
    return modelConnectionTestFingerprint({
        api,
        baseUrl: normalizeProviderBaseUrl(api, baseUrl),
        apiKey,
        modelId,
        ...(headers ? { headers } : {}),
    }, model);
}
// Unvalidated read, reserved for the MiniMax API view returned straight after a
// key write. The badge the settings UI renders comes from
// `getMinimaxApiKeyStatus`, which does check the fingerprint. BYOK provider
// views must use `fingerprintedProviderStatus` instead.
function statusOf(cache, providerId) {
    const view = cacheStatusView(cache.provider_status[providerId]);
    return view ? { status: view } : undefined;
}
//# sourceMappingURL=provider-views.js.map