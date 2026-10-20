import { decideOutputLimitRecovery, OUTPUT_LIMIT_EXHAUSTED_REASON, OUTPUT_LIMIT_RETRY_REASON, } from '@mavis/context-manager';
/**
 * Wires the context-manager output-limit recovery decision into
 * `after_llm_call`: a response cut off by the output limit before any visible
 * reply is dropped and retried with a hint, then fails visibly once the
 * retries are spent. Observers only report; they never change the decision.
 */
export function outputLimitRecoveryExtension(options = {}) {
    const afterLlmCall = async (event, ctx) => {
        const decision = decideOutputLimitRecovery(event.message, event.messages, options.maxRetries);
        const model = typeof event.message.model === 'string' ? event.message.model : undefined;
        switch (decision.kind) {
            case 'none':
                return { type: 'continue' };
            case 'recovered':
                await notify(options.onRecovered, observation(ctx, decision.attempts, model));
                return { type: 'continue' };
            case 'retry':
                await notify(options.onRetry, observation(ctx, decision.attempts, model, decision.truncatedToolCall));
                return { type: 'retry', reason: OUTPUT_LIMIT_RETRY_REASON, prompt: decision.prompt };
            case 'exhausted':
                await notify(options.onExhausted, observation(ctx, decision.attempts, model, decision.truncatedToolCall));
                return { type: 'fail', reason: OUTPUT_LIMIT_EXHAUSTED_REASON };
        }
    };
    return {
        id: options.id ?? 'output-limit-recovery',
        description: options.description ??
            'Retry a response cut off by the output limit before any visible reply, with a hint to reason briefly.',
        init(pi) {
            pi.on('after_llm_call', afterLlmCall);
        },
    };
}
function observation(ctx, attempts, model, truncatedToolCall) {
    return {
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        attempts,
        ...(truncatedToolCall === undefined ? {} : { truncatedToolCall }),
        ...(model === undefined ? {} : { model }),
    };
}
async function notify(observer, value) {
    if (!observer)
        return;
    try {
        await observer(value);
    }
    catch {
        // Observability must not change recovery semantics.
    }
}
//# sourceMappingURL=output-limit-recovery.js.map