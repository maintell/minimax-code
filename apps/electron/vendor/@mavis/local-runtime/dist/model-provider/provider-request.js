import { withOpenCodeGoHeaders, withOpenRouterAttributionHeaders } from '@mavis/shared';
const MESSAGES_VERSION_HEADER = 'anthropic-messages'.replace('-messages', '-version');
export function buildProviderHeaders(input) {
    const defaults = input.api === 'anthropic-messages'
        ? {
            'content-type': 'application/json',
            'x-api-key': input.apiKey,
            [MESSAGES_VERSION_HEADER]: '2023-06-01',
        }
        : {
            'content-type': 'application/json',
            Authorization: `Bearer ${input.apiKey}`,
        };
    const headers = new Headers(defaults);
    const attributedHeaders = withOpenCodeGoHeaders(input.baseUrl, withOpenRouterAttributionHeaders(input.baseUrl, input.headers));
    for (const [name, value] of Object.entries(attributedHeaders ?? {})) {
        headers.set(name, value);
    }
    return headers;
}
export function buildModelDiscoveryHeaders(input) {
    const headers = buildProviderHeaders(input);
    if (!headers.has('authorization'))
        headers.set('authorization', `Bearer ${input.apiKey}`);
    if (!headers.has('x-api-key'))
        headers.set('x-api-key', input.apiKey);
    return headers;
}
export function providerCompletionUrl(api, baseUrl) {
    const base = normalizeProviderBaseUrl(api, baseUrl);
    if (api === 'anthropic-messages')
        return `${base}/v1/messages`;
    if (api === 'openai-responses')
        return `${base}/responses`;
    return `${base}/chat/completions`;
}
export function providerModelsUrl(api, baseUrl) {
    const base = normalizeProviderBaseUrl(api, baseUrl);
    return api === 'anthropic-messages' ? `${base}/v1/models` : `${base}/models`;
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
    if (base.endsWith('/chat/completions'))
        base = base.slice(0, -'/chat/completions'.length);
    else if (base.endsWith('/responses'))
        base = base.slice(0, -'/responses'.length);
    return base;
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