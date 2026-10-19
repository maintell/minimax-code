// Minimal-completion connection tester for BYOK providers. Sends a single
// non-streaming request with a small output limit and normalizes the outcome to
// `unauthorized` / `timeout` / `network` / `http_<status>` /
// `provider_error` / `invalid_response`. Structured upstream failures retain
// their reason after removing configured secrets and common credential shapes.
import { buildProviderHeaders, providerCompletionUrl, } from './provider-request.js';
import { MINIMAX_M3_THINKING_TEST_MAX_TOKENS, resolveMiniMaxM3ThinkingProtocol, resolveModelThinkingProtocol, } from './thinking.js';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_UPSTREAM_ERROR_CHARS = 1_200;
export class ModelConnectionTester {
    fetchImpl;
    timeoutMs;
    inFlight = new Map();
    constructor(options = {}) {
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    }
    // One in-flight test per dedup key (provider or provider/model): concurrent
    // callers share the same pending promise instead of firing duplicates.
    test(dedupKey, target) {
        const pending = this.inFlight.get(dedupKey);
        if (pending)
            return pending;
        const run = this.runTest(target).finally(() => {
            this.inFlight.delete(dedupKey);
        });
        this.inFlight.set(dedupKey, run);
        return run;
    }
    async runTest(target) {
        const { url, init } = buildTestRequest(target);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
            if (response.ok)
                return await validateSuccessResponse(response, target.api, target);
            if (response.status === 401 || response.status === 403) {
                return {
                    ok: false,
                    errorCode: 'unauthorized',
                    errorMessage: `Authentication failed (HTTP ${response.status})`,
                };
            }
            const upstreamReason = await readUpstreamErrorReason(response, target);
            return {
                ok: false,
                errorCode: `http_${response.status}`,
                errorMessage: `HTTP ${response.status}${upstreamReason ? `: ${upstreamReason}` : ''}`,
            };
        }
        catch (err) {
            if (isAbortError(err)) {
                return {
                    ok: false,
                    errorCode: 'timeout',
                    errorMessage: `Request timed out after ${this.timeoutMs}ms`,
                };
            }
            return { ok: false, errorCode: 'network', errorMessage: 'Network error' };
        }
        finally {
            clearTimeout(timer);
        }
    }
}
async function readUpstreamErrorReason(response, target) {
    const raw = (await response.text()).trim();
    if (!raw || raw.startsWith('<'))
        return undefined;
    let detail;
    try {
        detail = extractStructuredErrorReason(JSON.parse(raw));
    }
    catch {
        detail = raw;
    }
    if (!detail)
        return undefined;
    return redactConnectionTestError(detail, target);
}
function extractStructuredErrorReason(value) {
    if (typeof value === 'string')
        return value.trim() || undefined;
    const record = readRecord(value);
    const explicitProviderError = extractExplicitProviderErrorReason(record);
    if (explicitProviderError)
        return explicitProviderError;
    for (const candidate of [record.message, record.detail, record.error_description]) {
        if (typeof candidate === 'string' && candidate.trim())
            return candidate.trim();
    }
    return undefined;
}
function extractExplicitProviderErrorReason(record) {
    const error = record.error;
    if (typeof error === 'string' && error.trim())
        return error.trim();
    const errorRecord = readRecord(error);
    for (const candidate of [errorRecord.message, errorRecord.detail, errorRecord.type]) {
        if (typeof candidate === 'string' && candidate.trim())
            return candidate.trim();
    }
    const baseResponse = readRecord(record.base_resp);
    const statusCode = normalizeProviderStatusCode(baseResponse.status_code);
    if (statusCode && statusCode !== '0') {
        for (const candidate of [baseResponse.status_msg, baseResponse.message, baseResponse.detail]) {
            if (typeof candidate !== 'string' || !candidate.trim())
                continue;
            const message = candidate.trim();
            return message.includes(statusCode) ? message : `${message} (${statusCode})`;
        }
        return `Provider error (${statusCode})`;
    }
    return undefined;
}
function normalizeProviderStatusCode(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return String(value);
    if (typeof value !== 'string')
        return undefined;
    return value.trim() || undefined;
}
function redactConnectionTestError(value, target) {
    let message = value.replace(/\s+/gu, ' ').trim();
    const secrets = [target.apiKey, ...Object.values(target.headers ?? {})]
        .map((secret) => secret.trim())
        .filter((secret) => secret.length >= 4)
        .sort((left, right) => right.length - left.length);
    for (const secret of secrets)
        message = message.split(secret).join('***');
    message = message
        .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/gu, 'sk-***')
        .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"',}]+/giu, '$1***')
        .replace(/((?:api[_-]?key|x-api-key)\s*[:=]\s*)[^\s"',}]+/giu, '$1***')
        .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/giu, '$1***')
        .slice(0, MAX_UPSTREAM_ERROR_CHARS)
        .trim();
    return message || undefined;
}
function buildTestRequest(target) {
    const messages = [{ role: 'user', content: 'ping' }];
    const thinking = resolveModelThinkingProtocol(target.api, target.effort, target.modelId);
    const requestPatch = target.minimaxM3ThinkingMode
        ? resolveMiniMaxM3ThinkingProtocol(target.api, target.minimaxM3ThinkingMode)
        : (thinking?.requestPatch ?? {});
    const maxTokens = target.minimaxM3ThinkingMode === 'on'
        ? MINIMAX_M3_THINKING_TEST_MAX_TOKENS
        : (thinking?.minimumMaxTokens ?? 1);
    if (target.api === 'anthropic-messages') {
        return {
            url: providerCompletionUrl(target.api, target.baseUrl),
            init: {
                method: 'POST',
                headers: buildProviderHeaders(target),
                body: JSON.stringify({
                    model: target.modelId,
                    max_tokens: maxTokens,
                    stream: false,
                    messages,
                    ...requestPatch,
                }),
            },
        };
    }
    if (target.api === 'openai-responses') {
        return {
            url: providerCompletionUrl(target.api, target.baseUrl),
            init: {
                method: 'POST',
                headers: buildProviderHeaders(target),
                body: JSON.stringify({
                    model: target.modelId,
                    input: 'ping',
                    max_output_tokens: 1,
                    stream: false,
                    ...requestPatch,
                }),
            },
        };
    }
    return {
        url: providerCompletionUrl(target.api, target.baseUrl),
        init: {
            method: 'POST',
            headers: buildProviderHeaders(target),
            body: JSON.stringify({
                model: target.modelId,
                max_tokens: 1,
                stream: false,
                messages,
                ...requestPatch,
            }),
        },
    };
}
async function validateSuccessResponse(response, api, target) {
    const payload = await readJsonBody(response);
    const providerError = extractExplicitProviderErrorReason(readRecord(payload));
    if (providerError) {
        return {
            ok: false,
            errorCode: 'provider_error',
            errorMessage: redactConnectionTestError(providerError, target) ?? 'Model provider error',
        };
    }
    if (api === 'anthropic-messages' && isMessagesResponse(payload)) {
        return { ok: true };
    }
    if (api === 'openai-completions' && isOpenAiChatCompletionsResponse(payload)) {
        return { ok: true };
    }
    if (api === 'openai-responses' && isOpenAiResponsesResponse(payload)) {
        return { ok: true };
    }
    return {
        ok: false,
        errorCode: 'invalid_response',
        errorMessage: 'Invalid response from model provider',
    };
}
async function readJsonBody(response) {
    try {
        return await response.json();
    }
    catch (err) {
        if (isAbortError(err))
            throw err;
        return undefined;
    }
}
function isMessagesResponse(payload) {
    const data = readRecord(payload);
    return Array.isArray(data.content);
}
function isOpenAiChatCompletionsResponse(payload) {
    const data = readRecord(payload);
    const choices = data.choices;
    if (!Array.isArray(choices) || choices.length === 0)
        return false;
    const first = readRecord(choices[0]);
    const message = readRecord(first.message);
    return typeof message.role === 'string';
}
function isOpenAiResponsesResponse(payload) {
    const data = readRecord(payload);
    return data.object === 'response' && typeof data.id === 'string' && Array.isArray(data.output);
}
function readRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
function isAbortError(err) {
    if (err instanceof Error && err.name === 'AbortError')
        return true;
    if (!err || typeof err !== 'object')
        return false;
    return err.name === 'AbortError';
}
//# sourceMappingURL=test-connection.js.map