import { withMiniMaxCodeUserAgent, withOpenCodeGoHeaders, withOpenRouterAttributionHeaders, } from '@mavis/shared';
const MESSAGES_VERSION_HEADER = 'anthropic-messages'.replace('-messages', '-version');
/** Gemini API version segment pi's Google transport expects inside the base URL. */
const GEMINI_DEFAULT_API_VERSION = 'v1beta';
/** Largest page the Gemini `models.list` endpoint accepts. */
const GEMINI_MODELS_PAGE_SIZE = 1000;
export function buildProviderHeaders(input) {
    const defaults = defaultProviderHeaders(input.api, input.apiKey);
    const headers = new Headers(defaults);
    const attributedHeaders = withMiniMaxCodeUserAgent(withOpenCodeGoHeaders(input.baseUrl, withOpenRouterAttributionHeaders(input.baseUrl, input.headers)));
    for (const [name, value] of Object.entries(attributedHeaders)) {
        headers.set(name, value);
    }
    return headers;
}
function defaultProviderHeaders(api, apiKey) {
    if (api === 'anthropic-messages') {
        return {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            [MESSAGES_VERSION_HEADER]: '2023-06-01',
        };
    }
    if (api === 'google-generative-ai') {
        return { 'content-type': 'application/json', 'x-goog-api-key': apiKey };
    }
    return { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` };
}
export function buildModelDiscoveryHeaders(input) {
    const headers = buildProviderHeaders(input);
    // Google rejects a non-OAuth bearer token even when an API key is present.
    if (input.api === 'google-generative-ai')
        return headers;
    if (!headers.has('authorization'))
        headers.set('authorization', `Bearer ${input.apiKey}`);
    if (!headers.has('x-api-key'))
        headers.set('x-api-key', input.apiKey);
    return headers;
}
export function providerCompletionUrl(api, baseUrl, modelId) {
    const base = normalizeProviderBaseUrl(api, baseUrl);
    if (api === 'anthropic-messages')
        return `${base}/v1/messages`;
    if (api === 'openai-responses')
        return `${base}/responses`;
    if (api === 'google-generative-ai')
        return `${base}/${geminiModelPath(modelId)}:generateContent`;
    return `${base}/chat/completions`;
}
/** Same resource naming as `@google/genai`: bare ids live under `models/`. */
function geminiModelPath(modelId) {
    return modelId.includes('/') ? modelId : `models/${modelId}`;
}
/**
 * 模型列表候选地址，按尝试顺序排列，首项是该协议的原生端点。Anthropic Messages
 * 兼容网关常常只实现 `/v1/messages`：DeepSeek 把 Messages 兼容面挂在
 * `https://api.deepseek.com` 的子路径下，模型列表在站点根 `/models`，所以原生端点
 * 缺失时还要给出同 base 与去前缀两个 OpenAI 风格候选。
 */
export function providerModelsUrls(api, baseUrl) {
    const base = normalizeProviderBaseUrl(api, baseUrl);
    if (api === 'google-generative-ai')
        return [`${base}/models?pageSize=${GEMINI_MODELS_PAGE_SIZE}`];
    if (api !== 'anthropic-messages')
        return [`${base}/models`];
    const primary = `${base}/v1/models`;
    const fallbacks = [`${base}/models`, originModelsUrl(base)].filter((url) => Boolean(url));
    return [primary, ...new Set(fallbacks)];
}
function originModelsUrl(base) {
    try {
        return `${new URL(base).origin}/models`;
    }
    catch {
        return undefined;
    }
}
export function normalizeProviderBaseUrl(api, baseUrl) {
    let base = baseUrl.replace(/\/+$/u, '');
    if (api === 'anthropic-messages') {
        if (base.endsWith('/v1/messages'))
            base = base.slice(0, -'/v1/messages'.length);
        else if (base.endsWith('/messages'))
            base = base.slice(0, -'/messages'.length);
        if (base.endsWith('/v1'))
            base = base.slice(0, -'/v1'.length);
        return base;
    }
    if (api === 'google-generative-ai')
        return normalizeGeminiBaseUrl(base);
    if (base.endsWith('/chat/completions'))
        base = base.slice(0, -'/chat/completions'.length);
    else if (base.endsWith('/responses'))
        base = base.slice(0, -'/responses'.length);
    return base;
}
/**
 * Pi's Google transport appends `/models/{id}:streamGenerateContent` to the base
 * as is, so the base keeps its version segment. A pasted method or models URL is
 * cut back to the version, and a bare origin gets Gemini's default version.
 */
function normalizeGeminiBaseUrl(baseUrl) {
    const base = baseUrl.replace(/\/models(?:\/[^/]+)?$/u, '');
    return URL.canParse(base) && new URL(base).pathname === '/'
        ? `${base}/${GEMINI_DEFAULT_API_VERSION}`
        : base;
}
export function mergeProviderHeaders(...records) {
    const merged = new Map();
    for (const record of records) {
        for (const [name, value] of Object.entries(record ?? {})) {
            merged.set(name.toLowerCase(), { name, value });
        }
    }
    return merged.size > 0
        ? Object.fromEntries([...merged.values()].map(({ name, value }) => [name, value]))
        : undefined;
}
//# sourceMappingURL=provider-request.js.map