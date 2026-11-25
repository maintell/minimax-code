import { composeStreamFn, withLLMRetry } from '@mavis/agent-core/pi-turn-runner';
import { validate } from '../sdk/model-request.js';
import { classify, usageOf } from './model-complete-result.js';
export class ExtensionModelCompleteService {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    /**
     * `signal` is the author's cancellation of this one call (the Worker's `cancel`); the inference
     * stops on it or on the end of the Invocation, whichever comes first.
     */
    async complete(callId, raw, signal) {
        return this.deps.boundary.run({ callId, domain: 'model', method: 'complete' }, async (invocation, detail) => {
            const request = validate(raw);
            detail.model = `${request.provider}/${request.modelId}`;
            const { pluginId, sessionId } = invocation.origin;
            const turnId = `ext:${pluginId}:${callId}`;
            let resolved;
            try {
                resolved = await this.deps.resolver.resolveModel({
                    sessionId,
                    turnId,
                    agentConfig: agentConfigFor(request),
                });
            }
            catch {
                detail.errorKind = 'resolver';
                detail.reason = 'model-unavailable';
                return { isAnswered: false, reason: 'model-unavailable' };
            }
            const outcome = await this.infer({ turnId, invocation, request, resolved, detail, signal });
            detail.reason = outcome.isAnswered ? 'answered' : outcome.reason;
            if (outcome.usage)
                detail.usage = outcome.usage;
            return outcome;
        });
    }
    async infer(input) {
        const { invocation, request, resolved, detail } = input;
        const cancel = cancellationOf(input.signal, invocation.signal);
        const controller = new AbortController();
        const forward = () => controller.abort(cancel?.reason);
        cancel?.addEventListener('abort', forward, { once: true });
        if (cancel?.aborted)
            forward();
        let timedOut = false;
        const timer = request.timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                if (controller.signal.aborted)
                    return;
                timedOut = true;
                controller.abort();
            }, request.timeoutMs);
        try {
            if (controller.signal.aborted) {
                detail.errorKind = 'aborted';
                return { isAnswered: false, reason: 'aborted' };
            }
            const response = await modelResponse({ resolved, request, invocation, turnId: input.turnId }, this.deps, controller.signal);
            const result = await response.result();
            const usage = usageOf(result.usage);
            const outcome = classify(result, timedOut, controller.signal.aborted);
            if (!outcome.isAnswered)
                detail.errorKind = result.stopReason;
            return usage ? { ...outcome, usage } : outcome;
        }
        catch {
            detail.errorKind = 'provider';
            const reason = failureReason(timedOut, controller.signal.aborted);
            return { isAnswered: false, reason };
        }
        finally {
            if (timer !== undefined)
                clearTimeout(timer);
            cancel?.removeEventListener('abort', forward);
        }
    }
}
/** The author's call signal and the Invocation's, as one; either may be missing. */
function cancellationOf(call, invocation) {
    const signals = [call, invocation].filter((signal) => signal !== undefined);
    return signals.length > 1 ? AbortSignal.any(signals) : signals[0];
}
function modelResponse(call, deps, signal) {
    const { resolved, request } = call;
    const stream = streamFor(call, deps);
    return stream(resolved.model, {
        ...(request.system === undefined ? {} : { systemPrompt: request.system }),
        messages: [{ role: 'user', content: request.prompt, timestamp: deps.nowMs() }],
    }, {
        ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
        ...(resolved.headers ? { headers: resolved.headers } : {}),
        maxTokens: Math.min(request.maxTokens ?? 1024, resolved.model.maxTokens, 64000),
        // Also bounds a call lifecycle's admission (an account's queue) by the author's timeout.
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        signal,
    });
}
/**
 * A model that owns its calls (agent subscriptions, a grouped failover plan, several BYOK keys)
 * only streams inside a call its lifecycle opened, as every other turn-less completion does. The
 * author owns the timeout and the cancellation, so the call is never retried.
 */
function streamFor(call, deps) {
    const { resolved, invocation } = call;
    const base = deps.stream ?? composeStreamFn(resolved);
    if (!resolved.callLifecycle)
        return base;
    return withLLMRetry(base, {
        sessionId: invocation.origin.sessionId,
        turnId: call.turnId,
        scope: 'extension',
        lifecycle: resolved.callLifecycle,
        policy: { maxRetries: 0 },
    });
}
function failureReason(timedOut, aborted) {
    if (timedOut)
        return 'timeout';
    return aborted ? 'aborted' : 'provider-error';
}
function agentConfigFor(request) {
    return {
        system_prompt: '',
        model: { provider: request.provider, model_id: request.modelId },
        tools: [],
        skills: [],
    };
}
//# sourceMappingURL=model-complete.service.js.map