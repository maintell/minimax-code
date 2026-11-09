import { createAssistantMessageEventStream, streamSimple, } from '@earendil-works/pi-ai';
import { abortLLMCallWithFailure, withLLMStreamCleanup, } from '@mavis/agent-core/pi-turn-runner';
import { ModelAccessRequestError } from '../../model-access-extension/index.js';
import { isModelAccessApi } from '../identity.js';
import { toolLoopNotice, toolLoopOf } from './tool-loop.js';
import { ModelAccessFailoverLease, ModelAccessRecordingLease } from '../failover/pool-lease.js';
const ACTIVE_ATTEMPT = Symbol('modelAccessAttempt');
/** Unmigrated callers fail closed rather than sending placeholder auth through a default route. */
export function requireModelAccessAttempt(inner = streamSimple) {
    return (model, context, options) => {
        const attempt = options?.[ACTIVE_ATTEMPT];
        if (!attempt)
            throw new ModelAccessRequestError('request_unavailable');
        attempt.assertCurrent();
        // A turn stuck asking the same tool call for the same result is answered here and sent
        // nowhere, in every mode, a subscription's allowance being finite.
        const loop = toolLoopOf(context);
        if (loop)
            return stoppedTurn(model, toolLoopNotice(loop));
        return inner(model, context, withToolResultFailures(model, context, options));
    };
}
/**
 * Chat Completions has no failed mark on a tool message, so a vendor that says a failure in the
 * text (Qoder, Devin) could not tell it. The tool messages pi sends
 * get `is_error: true` from the tool results that failed, for the extension to read; the vendor
 * request never carries it.
 */
function withToolResultFailures(model, context, options) {
    if (model.api !== 'openai-completions')
        return options;
    const failed = new Set();
    for (const m of context.messages)
        if (m.role === 'toolResult' && m.isError && m.toolCallId)
            failed.add(m.toolCallId);
    if (failed.size === 0)
        return options;
    const outer = options?.onPayload;
    return {
        ...options,
        onPayload: async (payload, payloadModel) => {
            const next = (await outer?.(payload, payloadModel)) ?? payload;
            const messages = next.messages;
            if (!Array.isArray(messages))
                return next;
            return {
                ...next,
                messages: messages.map((m) => m &&
                    typeof m === 'object' &&
                    m.role === 'tool' &&
                    failed.has(String(m.tool_call_id))
                    ? { ...m, is_error: true }
                    : m),
            };
        },
    };
}
/** A finished assistant turn with no call, said here instead of by the model. */
function stoppedTurn(model, text) {
    const out = createAssistantMessageEventStream();
    const message = {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [{ type: 'text', text }],
        timestamp: Date.now(),
        stopReason: 'stop',
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
    };
    out.push({ type: 'start', partial: { ...message, content: [] } });
    out.push({ type: 'text_start', contentIndex: 0, partial: { ...message, content: [] } });
    out.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: message });
    out.push({ type: 'text_end', contentIndex: 0, content: text, partial: message });
    out.push({ type: 'done', reason: 'stop', message });
    return out;
}
/**
 * Credentials are opened per logical call, never during turn preparation/model selection.
 * With failover enabled on the primary, the call runs over its pool (one member at a time);
 * otherwise it is exactly the single-provider lease.
 */
export function createModelAccessLifecycle(access, providerKey, pool) {
    return {
        async open(input) {
            const plan = pool ? failoverPlan(access, providerKey) : undefined;
            if (pool && plan && access.failover) {
                return ModelAccessFailoverLease.open({
                    access,
                    port: access.failover,
                    plan,
                    modelId: pool.modelId,
                    sessionId: input.sessionId,
                    scope: input.scope,
                    signal: input.signal,
                    open: (memberKey, signal, hooks) => openModelAccessCall(access, memberKey, signal, { hooks, sessionId: input.sessionId }),
                    ...(pool.logger ? { logger: pool.logger } : {}),
                });
            }
            // Without a pool the account still records its rests and a revoked sign-in.
            if (pool && access.failover)
                return ModelAccessRecordingLease.open({
                    port: access.failover,
                    providerKey,
                    modelId: pool.modelId,
                    open: (hooks) => openModelAccessCall(access, providerKey, input.signal, {
                        hooks,
                        sessionId: input.sessionId,
                    }),
                });
            return (await openModelAccessCall(access, providerKey, input.signal, { sessionId: input.sessionId })).lease;
        },
    };
}
/** Pool lookup errors fail closed; never silently spend the unselected original account. */
function failoverPlan(access, providerKey) {
    return access.failover?.plan(providerKey);
}
/** Management probes and ordinary LLM calls share the same call/attempt ownership. */
export async function openModelAccessCall(access, providerKey, signal, options = {}) {
    const { hooks = {}, sessionId } = options;
    const controller = new AbortController();
    const call = await access.requests.begin({
        providerKey,
        signal: AbortSignal.any([signal, controller.signal]),
        dependenciesReady: access.dependenciesReady(),
        // Hashed per installation before any extension sees it (ExtensionContext.sessionKey).
        ...(sessionId ? { sessionId } : {}),
    });
    return {
        call,
        lease: {
            signal: call.signal,
            close: () => call.close(),
            classifyFailure: (failure) => call.classifyFailure(failure),
            recover: (input) => call.recover(input),
            wrapAttempt: (inner) => attemptStream(inner, call, controller, hooks),
        },
    };
}
function attemptStream(inner, call, controller, hooks) {
    return async (model, context, options) => {
        let attempt;
        try {
            call.assertCurrent();
            attempt = await call.prepare({
                id: model.id,
                api: model.api,
                name: model.name,
                contextWindow: model.contextWindow,
                maxOutputTokens: model.maxTokens,
                input: model.input,
            });
            attempt.assertCurrent();
        }
        catch (error) {
            // Admission/identity/policy/cleanup failures are not provider transport retries. The call
            // ends with this error, so the caller learns why (a sign-in to renew), not "cancelled".
            hooks.onPrepareFailure?.(error);
            abortLLMCallWithFailure(controller, error);
            throw error;
        }
        const close = async () => {
            try {
                await attempt.close();
            }
            catch (error) {
                controller.abort();
                throw error;
            }
        };
        try {
            const transport = attempt.transport;
            if (!isModelAccessApi(transport.api) || !transport.fetch) {
                controller.abort();
                throw new ModelAccessRequestError('request_transport_invalid');
            }
            const signal = AbortSignal.any([
                attempt.signal,
                ...(options?.signal ? [options.signal] : []),
            ]);
            // Do not merge prior-account headers, endpoint, API key or a caller's default fetch.
            const attemptOptions = {
                ...options,
                apiKey: transport.apiKey ?? '',
                headers: { ...transport.headers },
                // Explicit SSE prevents a caller's WebSocket preference from bypassing the owned fetch.
                fetch: transport.fetch,
                transport: 'sse',
                signal,
                maxRetries: 0,
                [ACTIVE_ATTEMPT]: attempt,
            };
            const stream = await inner({
                ...model,
                id: transport.modelId,
                api: transport.api,
                baseUrl: transport.baseUrl,
                headers: undefined,
            }, context, attemptOptions);
            return withLLMStreamCleanup(stream, { signal, close });
        }
        catch (error) {
            await close();
            throw error;
        }
    };
}
//# sourceMappingURL=lifecycle.js.map