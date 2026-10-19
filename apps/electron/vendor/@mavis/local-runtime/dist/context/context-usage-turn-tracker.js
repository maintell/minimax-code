import { streamSimple, } from '@earendil-works/pi-ai';
import { RespDataType, } from '@mavis/agent-core/protocol/agent-message';
import { RuntimeEventType } from '@mavis/protocol';
import { applyToolCalibration, buildContextUsageMeasurement, estimatePreparedContext, } from './context-usage.js';
import { buildContextUsageProviderDiagnostics } from './context-usage-provider-diagnostics.js';
/**
 * Captures the Context prepared for each provider call and decorates completed
 * assistant frames. Product snapshots use the message usage anchor and never
 * capture the Provider wire payload or wait for Context Usage remote checks.
 */
export class ContextUsageTurnTracker {
    contextWindowTokens;
    promptRanges;
    onDebugMeasurement;
    calibrationCoordinator;
    providerDiagnosticCounter;
    requireProviderAnchor;
    measurementSeq = 0;
    latestMeasurement;
    constructor(contextWindowTokens, promptRanges, onDebugMeasurement, calibrationCoordinator, providerDiagnosticCounter, requireProviderAnchor = false) {
        this.contextWindowTokens = contextWindowTokens;
        this.promptRanges = promptRanges;
        this.onDebugMeasurement = onDebugMeasurement;
        this.calibrationCoordinator = calibrationCoordinator;
        this.providerDiagnosticCounter = providerDiagnosticCounter;
        this.requireProviderAnchor = requireProviderAnchor;
    }
    wrapStreamFn(inner) {
        const base = inner ?? streamSimple;
        return ((model, context, options) => {
            const seq = ++this.measurementSeq;
            const streamOptions = options;
            const diagnosticInput = this.providerDiagnosticCounter
                ? {
                    context: {
                        systemPrompt: context.systemPrompt,
                        tools: [...(context.tools ?? [])],
                        messages: [...(context.messages ?? [])],
                    },
                    model,
                    ...(streamOptions ? { streamOptions } : {}),
                }
                : undefined;
            const toolCalibrationInput = this
                .calibrationCoordinator
                ? {
                    context: {
                        systemPrompt: '',
                        tools: [...(context.tools ?? [])],
                        messages: [],
                    },
                    model,
                }
                : undefined;
            const toolCalibration = this.calibrationCoordinator?.getCachedToolCalibration({
                context,
                model,
            });
            const measurement = {
                seq,
                modelId: model.id,
                estimate: Promise.resolve().then(() => estimatePreparedContext(context, this.promptRanges, model)),
                ...(toolCalibration ? { toolCalibration } : {}),
                ...(toolCalibrationInput ? { toolCalibrationInput } : {}),
                ...(diagnosticInput ? { diagnosticInput } : {}),
            };
            this.latestMeasurement = measurement;
            if (this.calibrationCoordinator && !toolCalibration) {
                measurement.toolCalibrationRequest = this.calibrationCoordinator.calibrateTools({
                    context,
                    model,
                    ...(streamOptions ? { streamOptions } : {}),
                });
                void measurement.toolCalibrationRequest.then((result) => {
                    measurement.toolCalibration = result;
                });
            }
            if (!diagnosticInput)
                return base(model, context, options);
            const originalOnPayload = streamOptions?.onPayload;
            const captureOnPayload = async (payload, payloadModel) => {
                const transformed = await originalOnPayload?.(payload, payloadModel);
                diagnosticInput.exactProviderPayload = transformed ?? payload;
                return transformed;
            };
            return base(model, context, {
                ...(streamOptions ?? {}),
                onPayload: captureOnPayload,
            });
        });
    }
    async decorateRuntimeEvent(event) {
        if (event.type !== RuntimeEventType.STREAM_RESP)
            return event;
        const raw = event.payload?.stream_resp;
        if (typeof raw !== 'string' || !raw)
            return event;
        const respData = parseRespData(raw);
        const message = respData?.agent_message;
        if (respData?.type !== RespDataType.AgentMessage || !message)
            return event;
        const measurement = this.latestMeasurement;
        if (!measurement)
            return event;
        const providerUsage = readProviderUsage(message.usage);
        if (this.requireProviderAnchor &&
            (!hasProviderInputAnchor(providerUsage) ||
                !Number.isFinite(providerUsage?.contextWindow) ||
                (providerUsage?.contextWindow ?? 0) <= 0)) {
            return event;
        }
        const rawPrepared = await measurement.estimate.catch(() => undefined);
        if (!rawPrepared || measurement.seq !== this.measurementSeq)
            return event;
        const cachedToolCalibration = measurement.toolCalibrationInput && this.calibrationCoordinator
            ? this.calibrationCoordinator.getCachedToolCalibration({
                context: measurement.toolCalibrationInput.context,
                model: measurement.toolCalibrationInput.model,
            })
            : undefined;
        const toolCalibration = measurement.toolCalibration ?? cachedToolCalibration;
        if (measurement.seq !== this.measurementSeq)
            return event;
        const prepared = applyToolCalibration(rawPrepared, toolCalibration?.tokens);
        let measurementResult = buildContextUsageMeasurement({
            contextWindowTokens: this.requireProviderAnchor && providerUsage?.contextWindow
                ? providerUsage.contextWindow
                : this.contextWindowTokens,
            prepared,
            providerUsage,
            retainedTail: [wireAssistantToPiMessage(message)],
        });
        const localToolsTokens = rawPrepared.components.find((component) => component.kind === 'TOOLS')?.tokens ?? 0;
        if (toolCalibration) {
            measurementResult = {
                ...measurementResult,
                debug: {
                    ...measurementResult.debug,
                    toolCalibration: {
                        fingerprint: toolCalibration.fingerprint,
                        status: toolCalibration.status,
                        localTokens: localToolsTokens,
                        ...(toolCalibration.tokens === undefined
                            ? {}
                            : { calibratedTokens: toolCalibration.tokens }),
                    },
                },
            };
        }
        else if (measurement.toolCalibrationRequest &&
            measurement.toolCalibrationInput &&
            this.calibrationCoordinator) {
            measurementResult = {
                ...measurementResult,
                debug: {
                    ...measurementResult.debug,
                    toolCalibration: {
                        fingerprint: this.calibrationCoordinator.getToolFingerprint(measurement.toolCalibrationInput),
                        status: 'PENDING',
                        localTokens: localToolsTokens,
                    },
                },
            };
        }
        try {
            this.onDebugMeasurement?.(measurementResult.debug);
        }
        catch {
            // Debug capture must never affect the turn or the product snapshot.
        }
        if (this.providerDiagnosticCounter &&
            measurement.diagnosticInput &&
            !measurement.diagnosticsStarted &&
            (message.tool_calls?.length ?? 0) === 0) {
            measurement.diagnosticsStarted = true;
            void buildContextUsageProviderDiagnostics({
                ...measurement.diagnosticInput,
                promptRanges: this.promptRanges,
                prepared,
                counter: this.providerDiagnosticCounter,
                ...(measurementResult.debug.providerInputAnchor === undefined
                    ? {}
                    : { providerInputAnchor: measurementResult.debug.providerInputAnchor }),
            })
                .then((providerDiagnostics) => {
                if (measurement.seq !== this.measurementSeq)
                    return;
                try {
                    this.onDebugMeasurement?.({
                        ...measurementResult.debug,
                        providerDiagnostics,
                    });
                }
                catch {
                    // Optional diagnostics must never affect the turn.
                }
            })
                .catch(() => {
                // The diagnostic builder is fail-closed; keep this final guard so an
                // unexpected sidecar failure cannot become an unhandled rejection.
            });
        }
        const telemetry = event.turn_id && measurement.modelId
            ? {
                trigger: 'terminal',
                turnId: event.turn_id,
                model: measurement.modelId,
                localTokens: measurementResult.debug.rawPreparedTokens,
                ...(measurementResult.debug.providerInputAnchor === undefined
                    ? {}
                    : { providerTokens: measurementResult.debug.providerInputAnchor }),
                ...(measurementResult.debug.divergence.signedRate === null
                    ? {}
                    : { divergenceRate: measurementResult.debug.divergence.signedRate }),
                ...(measurementResult.debug.toolCalibration
                    ? {
                        toolCalibrationStatus: measurementResult.debug.toolCalibration.status,
                    }
                    : {}),
            }
            : undefined;
        const decorated = {
            ...respData,
            agent_message: {
                ...message,
                context_usage: measurementResult.snapshot,
                ...(telemetry ? { context_usage_telemetry: telemetry } : {}),
            },
        };
        return {
            ...event,
            payload: {
                ...event.payload,
                stream_resp: JSON.stringify(decorated),
            },
        };
    }
}
export function withContextUsageEventWriter(delegate, tracker) {
    return {
        async pushRuntime(event) {
            await delegate.pushRuntime(await tracker.decorateRuntimeEvent(event));
        },
        async appendEvents(events) {
            const decorated = [];
            for (const event of events) {
                decorated.push(await tracker.decorateRuntimeEvent(event));
            }
            await delegate.appendEvents(decorated);
        },
    };
}
function parseRespData(raw) {
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
function readProviderUsage(usage) {
    if (!usage || typeof usage !== 'object')
        return undefined;
    const raw = usage;
    return {
        ...(typeof raw.input_tokens === 'number' ? { input: raw.input_tokens } : {}),
        ...(typeof raw.output_tokens === 'number' ? { output: raw.output_tokens } : {}),
        ...(typeof raw.cache_read === 'number' ? { cacheRead: raw.cache_read } : {}),
        ...(typeof raw.cache_write === 'number' ? { cacheWrite: raw.cache_write } : {}),
        ...(typeof raw.total_tokens === 'number' ? { total: raw.total_tokens } : {}),
        ...(typeof raw.context_window === 'number' ? { contextWindow: raw.context_window } : {}),
    };
}
function hasProviderInputAnchor(usage) {
    return [usage?.input, usage?.cacheRead, usage?.cacheWrite].some((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0);
}
function wireAssistantToPiMessage(message) {
    const content = [];
    if (message.thinking_content) {
        content.push({ type: 'thinking', thinking: message.thinking_content });
    }
    if (message.msg_content) {
        content.push({ type: 'text', text: message.msg_content });
    }
    for (const toolCall of message.tool_calls ?? []) {
        content.push({
            type: 'toolCall',
            id: toolCall.tool_call_id,
            name: toolCall.tool_name,
            arguments: parseJsonValue(toolCall.tool_call_args),
        });
    }
    return {
        role: 'assistant',
        content,
        timestamp: message.timestamp ?? 0,
        stopReason: message.finish_reason ?? 'stop',
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
    };
}
function parseJsonValue(raw) {
    if (!raw)
        return {};
    try {
        return JSON.parse(raw);
    }
    catch {
        return raw;
    }
}
//# sourceMappingURL=context-usage-turn-tracker.js.map