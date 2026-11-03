import { streamSimple, } from '@earendil-works/pi-ai';
import { RespDataType, } from '@mavis/agent-core/protocol/agent-message';
import { RuntimeEventType } from '@mavis/protocol';
import { applyToolCalibration, buildContextUsageMeasurement, estimatePreparedContext, } from './context-usage.js';
import { ContextUsageCalibrationCoordinator, } from './context-usage-calibration.js';
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
    constructor(...args) {
        const [contextWindowTokens, promptRanges, onDebugMeasurement, calibrationCoordinator, providerDiagnosticCounter, requireProviderAnchor = false,] = args;
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
            const streamOptions = options;
            const measurement = this.prepareMeasurement(model, context, streamOptions);
            this.latestMeasurement = measurement;
            this.startToolCalibration(measurement, context, model, streamOptions);
            return this.invokeStream({ base, model, context, options, measurement });
        });
    }
    prepareMeasurement(model, context, streamOptions) {
        const seq = ++this.measurementSeq;
        const diagnosticInput = this.providerDiagnosticCounter
            ? buildDiagnosticInput(context, model, streamOptions)
            : undefined;
        const toolCalibrationInput = this.calibrationCoordinator
            ? buildToolCalibrationInput(context, model)
            : undefined;
        const toolCalibration = this.calibrationCoordinator?.getCachedToolCalibration({
            context,
            model,
        });
        return {
            seq,
            modelId: model.id,
            estimate: estimatePreparedContextAsync(context, this.promptRanges, model),
            ...(toolCalibration ? { toolCalibration } : {}),
            ...(toolCalibrationInput ? { toolCalibrationInput } : {}),
            ...(diagnosticInput ? { diagnosticInput } : {}),
        };
    }
    startToolCalibration(measurement, context, model, streamOptions) {
        if (!this.calibrationCoordinator || measurement.toolCalibration)
            return;
        const request = this.calibrationCoordinator.calibrateTools({
            context,
            model,
            ...(streamOptions ? { streamOptions } : {}),
        });
        measurement.toolCalibrationRequest = observeToolCalibration(request, measurement);
    }
    invokeStream(input) {
        const { base, model, context, options, measurement } = input;
        const diagnosticInput = measurement.diagnosticInput;
        if (!diagnosticInput)
            return base(model, context, options);
        const originalOnPayload = options?.onPayload;
        const captureOnPayload = async (payload, payloadModel) => {
            const transformed = await originalOnPayload?.(payload, payloadModel);
            diagnosticInput.exactProviderPayload = transformed ?? payload;
            return transformed;
        };
        return base(model, context, { ...options, onPayload: captureOnPayload });
    }
    async decorateRuntimeEvent(event) {
        const parsed = parseDecoratableEvent(event);
        if (!parsed)
            return event;
        const measurement = this.latestMeasurement;
        if (!measurement)
            return event;
        const providerUsage = readProviderUsage(parsed.message.usage);
        if (!providerAnchorIsAccepted(this.requireProviderAnchor, providerUsage))
            return event;
        const rawPrepared = await resolvePreparedEstimate(measurement);
        if (!rawPrepared || measurement.seq !== this.measurementSeq)
            return event;
        const toolCalibration = this.getToolCalibration(measurement);
        if (measurement.seq !== this.measurementSeq)
            return event;
        const prepared = applyToolCalibration(rawPrepared, toolCalibration?.tokens);
        const measurementResult = buildTrackedMeasurement({
            contextWindowTokens: this.contextWindowTokens,
            requireProviderAnchor: this.requireProviderAnchor,
            prepared,
            rawPrepared,
            providerUsage,
            toolCalibration,
            toolCalibrationPending: measurement.toolCalibrationRequest !== undefined,
            toolCalibrationFingerprint: this.getPendingFingerprint(measurement, toolCalibration),
            retainedTail: [wireAssistantToTokenEstimateMessage(parsed.message)],
        });
        this.emitDebugMeasurement(measurementResult.debug);
        this.startProviderDiagnostics(measurement, parsed.message, prepared, measurementResult.debug);
        return decorateEvent({
            event,
            respData: parsed.respData,
            message: parsed.message,
            measurementResult,
            measurement,
        });
    }
    getPendingFingerprint(measurement, calibration) {
        if (calibration || !measurement.toolCalibrationRequest || !measurement.toolCalibrationInput)
            return undefined;
        return this.calibrationCoordinator?.getToolFingerprint(measurement.toolCalibrationInput);
    }
    getToolCalibration(measurement) {
        if (measurement.toolCalibration)
            return measurement.toolCalibration;
        if (!measurement.toolCalibrationInput || !this.calibrationCoordinator)
            return undefined;
        return this.calibrationCoordinator.getCachedToolCalibration(measurement.toolCalibrationInput);
    }
    emitDebugMeasurement(measurement) {
        try {
            this.onDebugMeasurement?.(measurement);
        }
        catch {
            // Debug capture must never affect the turn or the product snapshot.
        }
    }
    startProviderDiagnostics(measurement, message, prepared, debug) {
        if (!this.providerDiagnosticCounter ||
            !measurement.diagnosticInput ||
            measurement.diagnosticsStarted ||
            (message.tool_calls?.length ?? 0) > 0) {
            return;
        }
        measurement.diagnosticsStarted = true;
        measurement.diagnosticsRequest = this.runProviderDiagnostics(measurement, prepared, debug, this.providerDiagnosticCounter);
    }
    async runProviderDiagnostics(measurement, prepared, debug, counter) {
        if (!measurement.diagnosticInput)
            return;
        try {
            const providerDiagnostics = await buildContextUsageProviderDiagnostics({
                ...measurement.diagnosticInput,
                promptRanges: this.promptRanges,
                prepared,
                counter,
                ...(debug.providerInputAnchor === undefined
                    ? {}
                    : { providerInputAnchor: debug.providerInputAnchor }),
            });
            if (measurement.seq !== this.measurementSeq)
                return;
            this.emitDebugMeasurement({ ...debug, providerDiagnostics });
        }
        catch {
            // Optional diagnostics must never affect the turn.
        }
    }
}
async function estimatePreparedContextAsync(context, promptRanges, model) {
    await Promise.resolve();
    return estimatePreparedContext(context, promptRanges, model);
}
function buildDiagnosticInput(context, model, streamOptions) {
    return {
        context: {
            systemPrompt: context.systemPrompt,
            tools: [...(context.tools ?? [])],
            messages: [...(context.messages ?? [])],
        },
        model,
        ...(streamOptions ? { streamOptions } : {}),
    };
}
function buildToolCalibrationInput(context, model) {
    return {
        context: {
            systemPrompt: '',
            tools: [...(context.tools ?? [])],
            messages: [],
        },
        model,
    };
}
async function observeToolCalibration(request, measurement) {
    try {
        const result = await request;
        measurement.toolCalibration = result;
        return result;
    }
    catch {
        return undefined;
    }
}
function parseDecoratableEvent(event) {
    if (event.type !== RuntimeEventType.STREAM_RESP)
        return undefined;
    const raw = event.payload?.stream_resp;
    if (typeof raw !== 'string' || !raw)
        return undefined;
    const respData = parseRespData(raw);
    const message = respData?.agent_message;
    return respData?.type === RespDataType.AgentMessage && message
        ? { respData, message }
        : undefined;
}
function providerAnchorIsAccepted(requireProviderAnchor, providerUsage) {
    return (!requireProviderAnchor ||
        (hasProviderInputAnchor(providerUsage) &&
            Number.isFinite(providerUsage?.contextWindow) &&
            (providerUsage?.contextWindow ?? 0) > 0));
}
async function resolvePreparedEstimate(measurement) {
    try {
        return await measurement.estimate;
    }
    catch {
        return undefined;
    }
}
function buildTrackedMeasurement(input) {
    let result = buildContextUsageMeasurement({
        contextWindowTokens: input.requireProviderAnchor && input.providerUsage?.contextWindow
            ? input.providerUsage.contextWindow
            : input.contextWindowTokens,
        prepared: input.prepared,
        providerUsage: input.providerUsage,
        retainedTail: input.retainedTail,
    });
    const localToolsTokens = input.rawPrepared.components.find((component) => component.kind === 'TOOLS')?.tokens ?? 0;
    const toolCalibrationDebug = buildToolCalibrationDebug({
        calibration: input.toolCalibration,
        pending: input.toolCalibrationPending,
        fingerprint: input.toolCalibrationFingerprint,
        localTokens: localToolsTokens,
    });
    if (toolCalibrationDebug) {
        result = {
            ...result,
            debug: { ...result.debug, toolCalibration: toolCalibrationDebug },
        };
    }
    return result;
}
function buildToolCalibrationDebug(input) {
    if (input.calibration) {
        return {
            fingerprint: input.calibration.fingerprint,
            status: input.calibration.status,
            localTokens: input.localTokens,
            ...(input.calibration.tokens === undefined
                ? {}
                : { calibratedTokens: input.calibration.tokens }),
        };
    }
    if (!input.pending)
        return undefined;
    return {
        fingerprint: input.fingerprint ?? '',
        status: 'PENDING',
        localTokens: input.localTokens,
    };
}
function decorateEvent(input) {
    const { event, respData, message, measurementResult, measurement } = input;
    const telemetry = buildTelemetry(event, measurement, measurementResult);
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
        payload: { ...event.payload, stream_resp: JSON.stringify(decorated) },
    };
}
function buildTelemetry(event, measurement, measurementResult) {
    if (!event.turn_id || !measurement.modelId)
        return undefined;
    return {
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
            ? { toolCalibrationStatus: measurementResult.debug.toolCalibration.status }
            : {}),
    };
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
/**
 * 仅供 BPE 估算：每个 assistant 字段对应独立文本块，保留逐字段编码与一次消息开销。
 * 不用于 provider replay；wire 消息没有 PI assistant 的模型元数据，不能伪造它们。
 */
function wireAssistantToTokenEstimateMessage(message) {
    const content = [];
    if (message.thinking_content) {
        content.push({ type: 'text', text: message.thinking_content });
    }
    if (message.msg_content) {
        content.push({ type: 'text', text: message.msg_content });
    }
    for (const toolCall of message.tool_calls ?? []) {
        content.push({ type: 'text', text: toolCall.tool_name }, {
            type: 'text',
            text: JSON.stringify(parseJsonValue(toolCall.tool_call_args)) ?? 'undefined',
        });
    }
    return { role: 'user', content, timestamp: message.timestamp ?? 0 };
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