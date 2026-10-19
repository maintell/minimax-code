import { resolveProviderCredential, minimaxApiModels, getRuntimeRegion } from '@mavis/config';
import { mergeProviderHeaders } from '../connectivity/provider-request.js';
import { isModelProviderApi, MANAGED_MINIMAX_PROVIDER_ID, MINIMAX_API_PROVIDER_ID, } from '../identity.js';
const BYOK_FALLBACK_MODEL_LIMITS = {
    contextWindow: 200_000,
    maxTokens: 16_384,
};
const MESSAGES_API_COMPAT_PATH = '\x61\x6e\x74\x68\x72\x6f\x70\x69\x63';
export function planMinimaxApiResolution(input) {
    const config = input.byok?.minimax_api;
    if (!config)
        return undefined;
    const apiKey = resolveProviderCredential({
        field: 'minimax_api.apiKey',
        provider: MINIMAX_API_PROVIDER_ID,
        value: config.apiKey,
    });
    if (!apiKey) {
        throw new Error('LocalModelResolver: minimax_api apiKey is not configured.');
    }
    const catalogModel = minimaxApiModels({ provider: input.providerConfig, minimax_api: config })[input.modelId];
    return {
        provider: MINIMAX_API_PROVIDER_ID,
        api: 'anthropic-messages',
        apiKey,
        baseUrl: config.baseURL?.trim() || defaultMinimaxApiBaseUrl(),
        contextWindow: catalogModel?.limit?.context ??
            (input.catalog.fromCatalog
                ? input.catalog.contextWindow
                : BYOK_FALLBACK_MODEL_LIMITS.contextWindow),
        maxTokens: catalogModel?.limit?.output ??
            (input.catalog.fromCatalog ? input.catalog.maxTokens : BYOK_FALLBACK_MODEL_LIMITS.maxTokens),
    };
}
export function planCustomProviderResolution(input) {
    const config = input.byok?.custom_provider?.[input.providerKey];
    if (!config || config.enabled === false)
        return undefined;
    const modelConfig = config.models?.[input.modelId];
    if (!modelConfig)
        return undefined;
    const credentials = resolveCustomProviderCredentials(config, input);
    const configHeaders = mergeProviderHeaders(readStringRecord(config.options?.headers), readStringRecord(modelConfig.headers));
    const modelCompat = readModelCompat(modelConfig.compat);
    return {
        provider: input.provider,
        api: resolveCustomProviderApi(config.api),
        ...credentials,
        ...customProviderLimits(modelConfig),
        ...(configHeaders ? { configHeaders } : {}),
        ...(modelCompat ? { modelCompat } : {}),
    };
}
function resolveCustomProviderCredentials(config, input) {
    const authProvider = config.kind === 'oauth' || config.options?.authMode === 'oauth' ? input.providerKey : undefined;
    const apiKey = resolveProviderCredential({
        field: 'custom_provider options.apiKey',
        provider: input.provider,
        value: config.options?.apiKey,
    });
    if (!apiKey && !authProvider) {
        throw new Error(`LocalModelResolver: api_key not configured for provider "${input.provider}".`);
    }
    const baseUrl = config.options?.baseURL?.trim();
    if (!baseUrl) {
        throw new Error(`LocalModelResolver: base_url not configured for provider "${input.provider}".`);
    }
    return {
        ...(apiKey ? { apiKey } : {}),
        ...(authProvider ? { authProvider, runtimeProvider: authProvider } : {}),
        baseUrl,
    };
}
function customProviderLimits(modelConfig) {
    return {
        contextWindow: modelConfig.limit?.context ?? BYOK_FALLBACK_MODEL_LIMITS.contextWindow,
        maxTokens: byokEffectiveOutputLimit(modelConfig),
    };
}
/**
 * Output budget a real BYOK turn sends for this model, configured limit or
 * default. The connection probe sends the same value so it stays a dry run of
 * the first real turn; a budget rejection can then only be a real one.
 */
export function byokEffectiveOutputLimit(modelConfig) {
    return modelConfig?.limit?.output ?? BYOK_FALLBACK_MODEL_LIMITS.maxTokens;
}
function resolveCustomProviderApi(value) {
    if (typeof value === 'string' &&
        (isModelProviderApi(value) || value === 'openai-codex-responses')) {
        return value;
    }
    return 'anthropic-messages';
}
export function firstBuiltinModel(providerConfig) {
    const preferredModelId = Object.keys(providerConfig?.[MANAGED_MINIMAX_PROVIDER_ID]?.models ?? {})[0];
    if (preferredModelId)
        return { provider: MANAGED_MINIMAX_PROVIDER_ID, modelId: preferredModelId };
    return Object.entries(providerConfig ?? {}).flatMap(([provider, config]) => {
        const modelId = Object.keys(config.models ?? {})[0];
        return modelId ? [{ provider, modelId }] : [];
    })[0];
}
export function readStringRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const entries = Object.entries(value).filter((entry) => typeof entry[1] === 'string');
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
const BOOLEAN_COMPAT_KEYS = [
    'supportsStore',
    'supportsDeveloperRole',
    'supportsReasoningEffort',
    'supportsUsageInStreaming',
    'requiresToolResultName',
    'requiresAssistantAfterToolResult',
    'requiresThinkingAsText',
    'requiresReasoningContentOnAssistantMessages',
    'supportsStrictMode',
    'supportsLongCacheRetention',
    'supportsEagerToolInputStreaming',
    'supportsCacheControlOnTools',
    'supportsTemperature',
    'sendSessionAffinityHeaders',
    'sendSessionIdHeader',
    'zaiToolStream',
    'forceAdaptiveThinking',
    'allowEmptySignature',
];
const MAX_TOKENS_FIELDS = [
    'max_tokens',
    'max_completion_tokens',
];
const THINKING_FORMATS = [
    'openai',
    'openrouter',
    'together',
    'deepseek',
    'zai',
    'qwen',
    'qwen-chat-template',
    'string-thinking',
    'ant-ling',
];
const CACHE_CONTROL_FORMATS = ['anthropic'];
function readCompatEnum(value, allowed) {
    return typeof value === 'string' ? allowed.find((option) => option === value) : undefined;
}
/**
 * Read model-level compatibility overrides out of untrusted provider config.
 *
 * The `custom_provider` config subtree is persisted as opaque JSON, so each field is
 * accepted only at its declared type. A value of the wrong type is dropped rather than
 * forwarded, because pi treats any present field as an explicit override and a truthy
 * string such as `"false"` would otherwise invert the intended behavior.
 */
function readModelCompat(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const source = { ...value };
    const compat = {};
    for (const key of BOOLEAN_COMPAT_KEYS) {
        const candidate = source[key];
        if (typeof candidate === 'boolean')
            compat[key] = candidate;
    }
    const maxTokensField = readCompatEnum(source.maxTokensField, MAX_TOKENS_FIELDS);
    if (maxTokensField)
        compat.maxTokensField = maxTokensField;
    const thinkingFormat = readCompatEnum(source.thinkingFormat, THINKING_FORMATS);
    if (thinkingFormat)
        compat.thinkingFormat = thinkingFormat;
    const cacheControlFormat = readCompatEnum(source.cacheControlFormat, CACHE_CONTROL_FORMATS);
    if (cacheControlFormat)
        compat.cacheControlFormat = cacheControlFormat;
    return Object.keys(compat).length > 0 ? compat : undefined;
}
function defaultMinimaxApiBaseUrl() {
    const origin = getRuntimeRegion() === 'cn' ? 'https://api.minimaxi.com' : 'https://api.minimax.io';
    return `${origin}/${MESSAGES_API_COMPAT_PATH}`;
}
//# sourceMappingURL=model-resolver-byok.js.map