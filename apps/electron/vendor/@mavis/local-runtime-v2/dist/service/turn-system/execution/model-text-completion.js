import { mutableTitleContext } from '../agent-host/preparation/config/title-context.js';
import { streamSimple } from '@earendil-works/pi-ai';
import { withLLMRetry } from '@mavis/agent-core/pi-turn-runner';
import { completeTitleModel } from '../../session-system/sessions/title/title-model-completion.js';
import { readSessionAgentExecutionSnapshot } from '../agent-host/preparation/session-agent-execution-snapshot.js';
/** Auxiliary text-only calls reuse the current Session's immutable model policy. */
export function createProductionModelTextCompletion(product, nowMs) {
    return (input) => completeTitleModel({
        buildAgentConfig: async (session) => {
            const agent = await readSessionAgentExecutionSnapshot(product.agents, session);
            if (!agent)
                throw new Error('Session Agent unavailable');
            return product.preparation.buildAgentConfig({
                session,
                agent,
                isSessionFirstTurn: false,
            });
        },
        resolveModel: async (request) => {
            const resolved = await product.preparation.resolveModel(request);
            // A model that owns its calls (agent subscriptions, several BYOK keys) only streams
            // inside a call its lifecycle opened, as the title models do.
            const resolvedStream = resolved.callLifecycle
                ? withLLMRetry(resolved.streamFn ?? streamSimple, {
                    sessionId: request.sessionId,
                    turnId: request.turnId,
                    scope: 'ppt',
                    lifecycle: resolved.callLifecycle,
                })
                : resolved.streamFn;
            return {
                model: resolved.model,
                apiKey: resolved.apiKey,
                headers: resolved.headers,
                thinkingLevel: resolved.thinkingLevel,
                ...(resolvedStream
                    ? {
                        stream: (model, context, options) => resolvedStream(model, mutableTitleContext(context), options),
                    }
                    : {}),
            };
        },
        stream: (model, context, options) => streamSimple(model, mutableTitleContext(context), options),
        nowMs,
    }, input);
}
//# sourceMappingURL=model-text-completion.js.map