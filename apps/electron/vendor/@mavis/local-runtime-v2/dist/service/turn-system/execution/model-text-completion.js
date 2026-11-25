import { streamSimple } from '@earendil-works/pi-ai';
import { withLLMRetry } from '@mavis/agent-core/pi-turn-runner';
import { buildLocalTurnPayloadTransform, readSessionAgentExecutionSnapshot, } from '@mavis/harness';
import { SessionTitleModelAdapter, } from '../../session-system/index.js';
import { completeTitleModel } from '../../session-system/sessions/title/title-model-completion.js';
import { mutableTitleContext, textCompletionStream, } from '../agent-host/preparation/text-completion.js';
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
            const resolvedStream = textCompletionStream(resolved, {
                sessionId: request.sessionId,
                turnId: request.turnId,
                scope: 'ppt',
            });
            return {
                model: resolved.model,
                apiKey: resolved.apiKey,
                headers: resolved.headers,
                thinkingLevel: resolved.thinkingLevel,
                stream: (model, context, options) => resolvedStream(model, mutableTitleContext(context), options),
            };
        },
        stream: (model, context, options) => streamSimple(model, mutableTitleContext(context), options),
        nowMs,
    }, input);
}
/** Uses the same product Agent/config/model resolution as normal native AgentHost turns. */
export function createProductionSessionTitleModel(product, nowMs) {
    const { preparation } = product;
    return new SessionTitleModelAdapter({
        buildAgentConfig: async (session) => {
            const agent = await readSessionAgentExecutionSnapshot(product.agents, session);
            if (!agent)
                throw new Error(`Session title Agent not found: ${session.agentName}`);
            return preparation.buildAgentConfig({
                session,
                agent,
                isSessionFirstTurn: true,
                // A title is a 1,000-token auxiliary request under a 10s budget: inheriting the
                // conversation's thinking tier spends that budget on reasoning instead of the summary.
                minimumThinking: true,
            });
        },
        resolveModel: async (input) => {
            const resolved = await preparation.resolveModel(input);
            const onPayload = input.purpose === 'review'
                ? buildLocalTurnPayloadTransform({ model: input.agentConfig.model }, {
                    thinkingLevel: resolved.thinkingLevel,
                    thinkingRequestPatch: resolved.thinkingRequestPatch,
                    managedProvider: resolved.managedProvider,
                })
                : undefined;
            const resolvedStream = resolved.callLifecycle || input.purpose === 'review'
                ? withLLMRetry(resolved.streamFn ?? streamSimple, {
                    sessionId: input.sessionId,
                    turnId: input.turnId,
                    scope: 'title',
                    lifecycle: resolved.callLifecycle,
                    ...(input.purpose === 'review' ? { policy: { maxRetries: 0 } } : {}),
                })
                : resolved.streamFn;
            return {
                model: resolved.model,
                apiKey: resolved.apiKey,
                headers: resolved.headers,
                ...(resolved.fetch ? { fetch: resolved.fetch } : {}),
                ...(resolved.thinkingLevel ? { thinkingLevel: resolved.thinkingLevel } : {}),
                ...(resolvedStream
                    ? {
                        stream: (model, context, options) => resolvedStream(model, mutableTitleContext(context), {
                            ...options,
                            ...(onPayload ? { onPayload } : {}),
                        }),
                    }
                    : {}),
            };
        },
        stream: (model, context, options) => streamSimple(model, mutableTitleContext(context), options),
        ...(nowMs ? { nowMs } : {}),
    });
}
//# sourceMappingURL=model-text-completion.js.map