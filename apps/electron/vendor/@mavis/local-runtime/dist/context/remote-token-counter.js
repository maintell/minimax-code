/**
 * Local auto-compaction trigger counter.
 *
 * The trigger decision should match the provider-bound payload, including the
 * composed system prompt and active tool declarations. The provider token
 * counter endpoint is ground truth; failures fall back to the shared BPE
 * estimate so a transient network/provider issue does not block the user turn.
 *
 * Result contract
 * ---------------
 * `countContextTokens` never throws. It returns a source-tagged result so the
 * caller can tell ground truth from an estimate: `source: 'remote'` is the
 * provider-reported `input_tokens`; `source: 'estimate'` is the shared BPE
 * estimate of the same logical context (the caller may floor it with its own
 * usage-based estimate).
 *
 * Messages-compatible models use `/v1/messages/count_tokens`. BYOK
 * OpenAI-compatible models use a source-specific tokenizer when the provider
 * exposes one, otherwise `/v1/responses/input_tokens`, while generation stays
 * on `/chat/completions` when that is the configured API format. A counter URL
 * that answers 404/405 is remembered for the process lifetime and skipped for
 * that adapter.
 */
import { estimateMessagesTokens, estimateSystemPromptAndToolTokens } from './token-estimator.js';
import { DEFAULT_REMOTE_TOKEN_COUNTER_ADAPTERS, resolveRemoteTokenCounterAdapter, } from './token-counter-adapters/registry.js';
import { logger } from '../common/logger.js';
export { buildResponsesInputTokensUrl } from './token-counter-adapters/responses.js';
const DEFAULT_TIMEOUT_MS = 3_000;
const BODY_PREVIEW_LIMIT = 500;
export class HttpRemoteTokenCounter {
    timeoutMs;
    fetchFn;
    adapters;
    /**
     * Base URLs whose counter endpoint answered 404/405 — the endpoint does not
     * exist there, so retrying on every LLM call would tax each turn with a
     * doomed full-context POST. Remembered for the process lifetime.
     */
    unsupportedBaseUrls = new Set();
    constructor(opts = {}) {
        this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.fetchFn = opts.fetchFn ?? fetch;
        this.adapters = opts.adapters ?? DEFAULT_REMOTE_TOKEN_COUNTER_ADAPTERS;
    }
    async countContextTokens(ctx) {
        const estimate = (fallbackReason) => {
            try {
                return {
                    tokens: estimateMessagesTokens(ctx.messages) +
                        estimateSystemPromptAndToolTokens(ctx.systemPrompt, ctx.tools),
                    source: 'estimate',
                    fallbackReason,
                };
            }
            catch (err) {
                logger.warn({
                    model: ctx.model.id,
                    api: ctx.model.api,
                    provider: ctx.model.provider,
                    error: err instanceof Error ? err.message : String(err),
                }, '[local-remote-token-counter] BPE fallback failed; returning zero estimate');
                return { tokens: 0, source: 'estimate', fallbackReason };
            }
        };
        if (!ctx.apiKey || !ctx.model.baseUrl)
            return estimate('counter_unavailable');
        const adapter = resolveRemoteTokenCounterAdapter(ctx, this.adapters);
        if (!adapter)
            return estimate('counter_unavailable');
        const hasPreparedProviderPayload = ctx.preparedPayload !== undefined || ctx.exactProviderPayload !== undefined;
        // Inline M3 media is prepared only after side-effect-free context trimming.
        // A standalone counter has no authority to upload it or send raw base64.
        if (adapter.id === 'anthropic-messages' &&
            !hasPreparedProviderPayload &&
            contextMayContainInlineMedia(ctx)) {
            return estimate('inline_media_unprepared');
        }
        const preflightUnsupportedCacheKey = adapter.id === 'anthropic-messages' ? `messages:${ctx.model.baseUrl}` : undefined;
        if (preflightUnsupportedCacheKey &&
            this.unsupportedBaseUrls.has(preflightUnsupportedCacheKey)) {
            return estimate('endpoint_unsupported');
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        const signal = ctx.signal
            ? AbortSignal.any([ctx.signal, controller.signal])
            : controller.signal;
        let request;
        try {
            const builtRequest = await awaitWithSignal(Promise.resolve(adapter.buildRequest(ctx)), signal);
            if (!builtRequest)
                return estimate('counter_unavailable');
            request = { ...builtRequest, adapter };
            if (this.unsupportedBaseUrls.has(request.unsupportedCacheKey)) {
                return estimate('endpoint_unsupported');
            }
            const res = await this.fetchFn(request.url, {
                method: 'POST',
                headers: request.headers,
                body: JSON.stringify(request.body),
                signal,
            });
            if (!res.ok) {
                if (res.status === 404 || res.status === 405) {
                    this.unsupportedBaseUrls.add(request.unsupportedCacheKey);
                    logger.warn({
                        url: request.url,
                        status: res.status,
                        kind: request.adapter.counterKind,
                        adapter_id: request.adapter.id,
                    }, '[local-remote-token-counter] token counter endpoint missing; disabling remote counting for this base url');
                }
                else {
                    logger.warn({
                        url: request.url,
                        status: res.status,
                        kind: request.adapter.counterKind,
                        adapter_id: request.adapter.id,
                    }, '[local-remote-token-counter] non-2xx; using BPE fallback');
                }
                return estimate(`http_${res.status}`);
            }
            const json = (await res.json());
            const tokens = request.adapter.parseTokens(json);
            if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens <= 0) {
                logger.warn({
                    url: request.url,
                    kind: request.adapter.counterKind,
                    adapter_id: request.adapter.id,
                    body_preview: buildSafeJsonPreview(json),
                }, '[local-remote-token-counter] malformed body; using BPE fallback');
                return estimate('malformed_body');
            }
            return {
                tokens,
                source: 'remote',
                counterKind: request.adapter.counterKind,
            };
        }
        catch (err) {
            if (!request) {
                logger.warn({
                    model: ctx.model.id,
                    api: ctx.model.api,
                    provider: ctx.model.provider,
                    error: err instanceof Error ? err.message : String(err),
                }, '[local-remote-token-counter] request build failed/timed out; using BPE fallback');
                return estimate('request_build_failed');
            }
            logger.warn({
                url: request.url,
                kind: request.adapter.counterKind,
                adapter_id: request.adapter.id,
                error: err instanceof Error ? err.message : String(err),
            }, '[local-remote-token-counter] request failed/timed out; using BPE fallback');
            return estimate('request_failed');
        }
        finally {
            clearTimeout(timer);
        }
    }
}
function contextMayContainInlineMedia(ctx) {
    if (!ctx.model.input.includes('image'))
        return false;
    const visit = (value) => {
        if (!value || typeof value !== 'object')
            return false;
        if (Array.isArray(value))
            return value.some(visit);
        const record = value;
        return (record.type === 'image' ||
            record.type === 'video' ||
            (Array.isArray(record.content) && record.content.some(visit)));
    };
    return ctx.messages.some(visit);
}
function awaitWithSignal(promise, signal) {
    // The signal only bounds our wait; it cannot cancel a promise unless that
    // promise receives and honors a signal. Adapter construction is therefore
    // required to stay pure and must never upload or perform other side effects.
    if (signal.aborted)
        return Promise.reject(signal.reason ?? new Error('aborted'));
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback) => {
            if (settled)
                return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            callback();
        };
        const onAbort = () => finish(() => reject(signal.reason ?? new Error('aborted')));
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
    });
}
function buildSafeJsonPreview(value) {
    const redact = (input, depth) => {
        if (depth > 4)
            return '[max-depth]';
        if (input === null || typeof input === 'number' || typeof input === 'boolean')
            return input;
        if (typeof input === 'string')
            return `[string:${input.length}]`;
        if (Array.isArray(input))
            return input.slice(0, 10).map((item) => redact(item, depth + 1));
        if (typeof input !== 'object')
            return `[${typeof input}]`;
        return Object.fromEntries(Object.entries(input)
            .slice(0, 30)
            .map(([key, child]) => [key, redact(child, depth + 1)]));
    };
    try {
        return JSON.stringify(redact(value, 0)).slice(0, BODY_PREVIEW_LIMIT);
    }
    catch {
        return '[unserializable]';
    }
}
//# sourceMappingURL=remote-token-counter.js.map