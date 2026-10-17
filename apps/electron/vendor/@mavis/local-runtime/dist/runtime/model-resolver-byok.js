import { minimaxApiModels, resolveProviderCredential } from '@mavis/config';
import { MINIMAX_API_DEFAULT_BASE_URL } from '../model-provider/list-models.js';
import { mergeProviderHeaders, normalizeProviderBaseUrl, } from '../model-provider/provider-request.js';
export const BYOK_FALLBACK_MODEL_LIMITS = {
    contextWindow: 200_000,
    maxTokens: 16_384,
};
export async function resolveByokResolutionPlan(plan, providerAuthGetter) {
    const { authProvider, apiKey: configuredApiKey, ...resolved } = plan;
    const apiKey = (authProvider ? await providerAuthGetter?.(authProvider) : configuredApiKey)?.trim();
    if (!apiKey) {
        throw new Error(authProvider
            ? `LocalModelResolver: ${authProvider} login required; no OAuth credentials found.`
            : `LocalModelResolver: api_key not configured for provider "${plan.provider}".`);
    }
    return { ...resolved, apiKey };
}
export function planMinimaxApiResolution(input) {
    const cfg = input.byok?.minimax_api;
    if (!cfg)
        return undefined;
    const apiKey = resolveProviderCredential({
        field: 'minimax_api.apiKey',
        provider: 'minimax_api',
        value: cfg.apiKey,
    });
    if (!apiKey) {
        throw new Error('LocalModelResolver: minimax_api apiKey is not configured.');
    }
    const catalogModel = minimaxApiModels({ provider: input.providerConfig, minimax_api: cfg })[input.modelId];
    return {
        provider: 'minimax_api',
        api: 'anthropic-messages',
        apiKey,
        baseUrl: normalizeProviderBaseUrl('anthropic-messages', cfg.baseURL?.trim() || MINIMAX_API_DEFAULT_BASE_URL),
        contextWindow: catalogModel?.limit?.context ??
            (input.catalog.fromCatalog
                ? input.catalog.contextWindow
                : BYOK_FALLBACK_MODEL_LIMITS.contextWindow),
        maxTokens: catalogModel?.limit?.output ??
            (input.catalog.fromCatalog ? input.catalog.maxTokens : BYOK_FALLBACK_MODEL_LIMITS.maxTokens),
    };
}
export function planCustomProviderResolution(input) {
    const cfg = input.byok?.custom_provider?.[input.providerKey];
    if (!cfg)
        return undefined;
    // Disabled providers keep their config but must never be called.
    if (cfg.enabled === false)
        return undefined;
    // Custom models must come from the user's config: an unconfigured model id
    // (deleted, typo, dangling session reference) is rejected by the caller.
    const modelConfig = cfg.models?.[input.modelId];
    if (!modelConfig)
        return undefined;
    const authProvider = cfg.kind === 'oauth' || cfg.options?.authMode === 'oauth' ? input.providerKey : undefined;
    const apiKey = resolveProviderCredential({
        field: 'custom_provider options.apiKey',
        provider: input.provider,
        value: cfg.options?.apiKey,
    });
    if (!apiKey && !authProvider) {
        throw new Error(`LocalModelResolver: api_key not configured for provider "${input.provider}".`);
    }
    const baseUrl = cfg.options?.baseURL?.trim();
    if (!baseUrl) {
        throw new Error(`LocalModelResolver: base_url not configured for provider "${input.provider}".`);
    }
    const configHeaders = mergeProviderHeaders(readStringRecord(cfg.options?.headers), readStringRecord(modelConfig.headers));
    const api = resolveCustomProviderApi(cfg.api);
    return {
        provider: input.provider,
        api,
        ...(apiKey ? { apiKey } : {}),
        ...(authProvider ? { authProvider, runtimeProvider: authProvider } : {}),
        baseUrl: api === 'openai-codex-responses'
            ? baseUrl.replace(/\/+$/u, '')
            : normalizeProviderBaseUrl(api, baseUrl),
        contextWindow: modelConfig.limit?.context ?? BYOK_FALLBACK_MODEL_LIMITS.contextWindow,
        maxTokens: modelConfig.limit?.output ?? BYOK_FALLBACK_MODEL_LIMITS.maxTokens,
        ...(configHeaders ? { configHeaders } : {}),
    };
}
function resolveCustomProviderApi(value) {
    if (value === 'openai-completions' ||
        value === 'openai-responses' ||
        value === 'openai-codex-responses') {
        return value;
    }
    return 'anthropic-messages';
}
export function readStringRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const entries = Object.entries(value).filter((entry) => typeof entry[1] === 'string');
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
//# sourceMappingURL=model-resolver-byok.js.map