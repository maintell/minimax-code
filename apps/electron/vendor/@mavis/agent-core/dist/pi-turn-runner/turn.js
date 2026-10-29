import { EventBridge } from '../event-bridge/index.js';
import { composeStreamFn, resolveHostOutputTokenCap } from './llm.js';
import { withLLMRetry } from './llm-retry.js';
import { newTools } from './tools.js';
export function newTurn(input, deps) {
    const resolved = input.llm;
    const composedStreamFn = composeStreamFn(resolved);
    const retryStream = (scope) => {
        const metricsStreamFn = deps.metrics
            ? deps.metrics.wrapStreamFn(composedStreamFn, { recordTerminalFailure: false })
            : composedStreamFn;
        const callerObserver = input.llmRetry?.observer;
        const callerOnCallSettled = input.llmRetry?.onCallSettled;
        const retryingStreamFn = withLLMRetry(metricsStreamFn, {
            ...input.llmRetry,
            sessionId: input.sessionId,
            turnId: input.turnId,
            scope,
            observer: async (event) => {
                deps.metrics?.observeRetry(event);
                await callerObserver?.(event);
            },
            onCallSettled: (event) => {
                deps.metrics?.observeLLMCall(event);
                deps.llmCapture?.observeCallSettled(event);
                return callerOnCallSettled?.(event);
            },
        });
        // One recorder spans the whole logical call. Physical retries overwrite its
        // in-memory candidate; only the final successful settlement can persist.
        const capturedStreamFn = deps.llmCapture
            ? deps.llmCapture.wrapLogicalStreamFn(retryingStreamFn, { scope })
            : retryingStreamFn;
        return deps.metrics
            ? deps.metrics.wrapLogicalStreamFn(capturedStreamFn, {
                // Auto-compaction is an auxiliary degradation: local context lifecycle
                // catches its failure and may continue with the main request. Keep its
                // physical request/retry metrics, but never let it claim the turn's
                // terminal LLM attribution or overwrite the main failure classification.
                recordTerminalFailure: scope === 'agent',
            })
            : capturedStreamFn;
    };
    const mainStreamFn = input.llmRetry || deps.llmCapture
        ? retryStream('agent')
        : deps.metrics
            ? deps.metrics.wrapStreamFn(composedStreamFn)
            : composedStreamFn;
    const auxiliaryStreamFn = input.llmRetry ? retryStream('compaction') : undefined;
    const syntheticResponse = {};
    let eventSeq = 0;
    let runtimeSeq = 0;
    const nextEventId = input.eventIdGenerator ?? ((kind) => `evt_${input.turnId}_${kind}_${++eventSeq}`);
    const nextRuntimeSeq = input.runtimeSeqGenerator ?? (() => ++runtimeSeq);
    const modelContextWindow = resolved.model.contextWindow;
    const provenanceResolvers = new Map((input.toolConfig.tools ?? []).flatMap((tool) => tool.toolCallProvenanceResolver
        ? [[tool.def.name, tool.toolCallProvenanceResolver]]
        : []));
    const toolCallProvenanceResolver = input.toolCallProvenanceResolver ??
        (provenanceResolvers.size > 0
            ? (resolution) => provenanceResolvers.get(resolution.toolName)?.(resolution)
            : undefined);
    const bridge = new EventBridge({
        sessionId: input.sessionId,
        turnId: input.turnId,
        eventIdGenerator: nextEventId,
        runtimeSeqGenerator: nextRuntimeSeq,
        nowMs: deps.nowMs,
        ...(deps.metrics && input.includeDetailedUsage === true
            ? { requestDurationMs: deps.metrics.requestDurationMsFor.bind(deps.metrics) }
            : {}),
        ...(input.includeDetailedUsage === true ? { includeDetailedUsage: true } : {}),
        logger: deps.logger,
        ...(input.captureToolTiming ? { captureToolTiming: true } : {}),
        ...(toolCallProvenanceResolver ? { toolCallProvenanceResolver } : {}),
        ...(typeof modelContextWindow === 'number' &&
            Number.isFinite(modelContextWindow) &&
            modelContextWindow > 0
            ? { contextWindow: modelContextWindow }
            : {}),
    });
    const tools = newTools(input.workspaceDir, input.toolConfig.tools ?? [], input.toolConfig.context, {
        disableBuiltinFallback: input.toolConfig.disableBuiltinToolFallback === true,
        readAssistantMessageId: () => bridge.getActiveAssistantMessageId(),
    });
    const hooks = {
        beforeLLM: input.hooks?.beforeLlmCallHook ?? [],
        onLLMPrepared: input.hooks?.onLlmCallPreparedHook ?? [],
        afterLLM: input.hooks?.afterLlmCallHook ?? [],
        beforeTool: input.hooks?.beforeToolCallHook ?? [],
        onToolExecutionStart: input.hooks?.onToolExecutionStartHook ?? [],
        afterTool: input.hooks?.afterToolCallHook ?? [],
        onHistory: input.hooks?.onHistoryChangedHook ?? [],
        // Preserve legacy per-step handlers after preferred-name handlers.
        onStepEnd: [...(input.hooks?.onStepEndHook ?? []), ...(input.hooks?.onTurnEndHook ?? [])],
    };
    return {
        input,
        llm: resolved,
        writer: input.eventWriter,
        allocator: deps.allocator,
        logger: deps.logger,
        metrics: deps.metrics,
        bridge,
        hooks,
        tools,
        streamFn: withSyntheticResponse(withLlmCallPreparedObservers(mainStreamFn, {
            input,
            llm: resolved,
            tools,
            thinkingLevel: resolved.thinkingLevel ?? 'off',
            hooks: hooks.onLLMPrepared,
            logger: deps.logger,
        }), syntheticResponse, deps.nowMs),
        ...(auxiliaryStreamFn
            ? {
                auxiliaryStreamFn,
            }
            : {}),
        thinkingLevel: resolved.thinkingLevel ?? 'off',
        initialMessages: [...(input.history ?? [])],
        blockedToolCalls: [],
        syntheticResponse,
        rejectedAssistantMessages: new Set(),
        requestStoppedBeforeSend: false,
        recovery: { used: false },
        nextEventId,
        nextRuntimeSeq,
    };
}
function withLlmCallPreparedObservers(inner, options) {
    if (options.hooks.length === 0)
        return inner;
    let logicalCallCount = 0;
    return (async (model, context, streamOptions) => {
        const phase = logicalCallCount === 0 ? 'initial' : 'iteration';
        logicalCallCount += 1;
        for (const hook of options.hooks) {
            try {
                const hostMaxOutputTokens = resolveHostOutputTokenCap(options.llm);
                await hook({
                    sessionId: options.input.sessionId,
                    turnId: options.input.turnId,
                    phase,
                    scope: 'agent',
                    messages: [...context.messages],
                    model,
                    ...(options.llm.maxTokens === undefined ? {} : { maxTokens: options.llm.maxTokens }),
                    ...(hostMaxOutputTokens === undefined ? {} : { hostMaxOutputTokens }),
                    ...(options.llm.maxSerializedInputBytes === undefined
                        ? {}
                        : { maxSerializedInputBytes: options.llm.maxSerializedInputBytes }),
                    ...(options.llm.cacheRetention === undefined
                        ? {}
                        : { cacheRetention: options.llm.cacheRetention }),
                    systemPrompt: options.input.systemPrompt,
                    tools: options.tools.map((tool) => ({
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.parameters,
                    })),
                    thinkingLevel: options.thinkingLevel,
                    ...(streamOptions?.signal ? { signal: streamOptions.signal } : {}),
                });
            }
            catch (error) {
                try {
                    options.logger.warn({
                        session_id: options.input.sessionId,
                        turn_id: options.input.turnId,
                        phase,
                        error: error instanceof Error ? error.message : String(error),
                    }, '[pi-turn-runner] onLlmCallPrepared hook failed; continuing provider call');
                }
                catch {
                    // Observers and their diagnostics must never replace the provider call.
                }
            }
        }
        return inner(model, context, streamOptions);
    });
}
function withSyntheticResponse(inner, state, nowMs) {
    return ((model, context, options) => {
        const pending = state.pending;
        if (!pending)
            return inner(model, context, options);
        delete state.pending;
        const empty = trustedAssistantMessage(model, '', nowMs());
        const final = trustedAssistantMessage(model, pending.text, nowMs());
        const events = [
            { type: 'start', partial: empty },
            { type: 'text_start', contentIndex: 0, partial: empty },
            { type: 'text_delta', contentIndex: 0, delta: pending.text, partial: final },
            { type: 'text_end', contentIndex: 0, content: pending.text, partial: final },
            { type: 'done', reason: 'stop', message: final },
        ];
        return {
            [Symbol.asyncIterator]() {
                let index = 0;
                return {
                    async next() {
                        const value = events[index];
                        index += 1;
                        return value ? { value, done: false } : { value: undefined, done: true };
                    },
                };
            },
            result: async () => final,
        };
    });
}
function trustedAssistantMessage(model, text, timestamp) {
    return {
        role: 'assistant',
        content: text ? [{ type: 'text', text }] : [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp,
    };
}
//# sourceMappingURL=turn.js.map