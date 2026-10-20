import { randomUUID } from 'node:crypto';
import { DEFAULT_COMPACTION_SETTINGS } from '@earendil-works/pi-coding-agent/compaction';
import { resolveCompactionTokenBudget } from '@mavis/context-manager';
import { compactContext, } from './algorithm/compact-context.js';
import { createCheckpointSession, } from './execution/checkpoint-provider.js';
import { checkpointMaxOutputTokens } from './execution/checkpoint-prompt.js';
import { createLocalContextFootprintMeasurer } from './execution/local-context-footprint.js';
/** Manual caller: bypasses the automatic trigger and transient filters. */
export class LocalContextCompactor {
    checkpointState;
    logger;
    promptSnapshots;
    checkpointContext;
    imageFileWriter;
    resolveEarlierFiles;
    constructor(checkpointState, logger, promptSnapshots, context = {}) {
        this.checkpointState = checkpointState;
        this.logger = logger;
        this.promptSnapshots = promptSnapshots;
        this.checkpointContext = {
            reminder: context.reminder,
            projectRequestMessages: context.projectRequestMessages,
        };
        this.imageFileWriter = context.imageFileWriter;
        this.resolveEarlierFiles = context.resolveEarlierFiles;
    }
    async compactManual(input, hooks) {
        input.signal?.throwIfAborted();
        const preparation = prepareManualCompaction(input);
        await hooks?.onStarted();
        input.signal?.throwIfAborted();
        const decision = await runManualPolicy({
            input,
            hooks,
            preparation,
            checkpointState: this.checkpointState,
            logger: this.logger,
            promptSnapshots: this.promptSnapshots,
            checkpointReminder: this.checkpointContext.reminder,
            checkpointRequestMessages: this.checkpointContext.projectRequestMessages,
            imageFileWriter: this.imageFileWriter,
            resolveEarlierFiles: this.resolveEarlierFiles,
        });
        logManualReplacementGrowthBestEffort(this.logger, input.sessionId, decision, {
            providerInputLimit: preparation.providerInputLimit,
        });
        return completedManualCompaction(preparation.history, decision);
    }
}
function prepareManualCompaction(input) {
    const history = [...input.messages];
    const measurer = createLocalContextFootprintMeasurer({
        model: input.model,
        ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
        ...(input.tools === undefined ? {} : { tools: input.tools }),
    });
    const before = measurer.measure(history);
    return {
        history,
        measurer,
        before,
        providerInputLimit: resolveCompactionTokenBudget({
            contextWindow: input.model.contextWindow,
            configuredMaxOutputTokens: input.maxTokens ?? input.model.maxTokens,
        }).providerInputLimit,
    };
}
async function runManualPolicy(options) {
    const { input, hooks, preparation, checkpointReminder, imageFileWriter, resolveEarlierFiles } = options;
    return compactContext({
        ...(checkpointReminder
            ? { checkpointReminder: (timestamp) => checkpointReminder(input.sessionId, timestamp) }
            : {}),
        history: preparation.history,
        ...(resolveEarlierFiles
            ? { resolveEarlierFiles: () => resolveEarlierFiles(input.sessionId) }
            : {}),
        ...(imageFileWriter
            ? {
                writeImageFile: (messages, image) => imageFileWriter.writeImageFile({ sessionId: input.sessionId, messages }, image),
            }
            : {}),
        ...(input.customInstructions === undefined ? {} : { instructions: input.customInstructions }),
        limits: manualLimits(input, preparation.providerInputLimit),
        measurePair: async (pair) => preparation.measurer.measurePair(pair),
        allowLegacyToolTrim: false,
        // An explicit user request always commits a validly generated checkpoint.
        // Growth is possible on short histories (checkpoint output cap plus host
        // appendix) and stays bounded; it is observed below, never intercepted.
        finalAdmission: 'bypass',
        checkpoint: manualCheckpoint({
            input,
            hooks,
            tokensBefore: preparation.before.inputTokens,
            providerInputLimit: preparation.providerInputLimit,
            promptSnapshots: options.promptSnapshots,
            projectRequestMessages: options.checkpointRequestMessages,
        }),
        ...manualSubagentCapture(input.sessionId, options.checkpointState, options.logger),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
}
function manualLimits(input, providerInputLimit) {
    return {
        providerInputLimit,
        ...(input.maxSerializedInputBytes === undefined
            ? {}
            : { maxSerializedInputBytes: input.maxSerializedInputBytes }),
    };
}
function manualCheckpoint({ input, hooks, tokensBefore, providerInputLimit, promptSnapshots, projectRequestMessages, }) {
    return {
        tokensBefore,
        timestamp: Date.now(),
        ...(hooks?.onCheckpointAttemptSettled
            ? { onAttemptSettled: hooks.onCheckpointAttemptSettled }
            : {}),
        ...(hooks?.getProviderTokenUsage ? { getTokenUsage: hooks.getProviderTokenUsage } : {}),
        open: async () => {
            if (!input.streamFn) {
                throw new TypeError('Manual context compaction requires streamFn for checkpoint.');
            }
            return createCheckpointSession({
                projectRequestMessages,
                model: input.model,
                streamFn: input.streamFn,
                thinkingLevel: input.thinkingLevel,
                providerInputLimit,
                maxOutputTokens: checkpointMaxOutputTokens(DEFAULT_COMPACTION_SETTINGS.reserveTokens, input.maxTokens ?? input.model.maxTokens, input.model.contextWindow),
                ...(input.maxSerializedInputBytes === undefined
                    ? {}
                    : { maxSerializedInputBytes: input.maxSerializedInputBytes }),
                ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
                ...(input.headers === undefined ? {} : { headers: input.headers }),
                ...(input.payloadTransform === undefined
                    ? {}
                    : { payloadTransform: input.payloadTransform }),
                ...(hooks?.onProviderRequestSettled
                    ? { onRequestSettled: hooks.onProviderRequestSettled }
                    : {}),
                onGenerated: (generation) => hooks?.onCheckpointGenerated?.({
                    responseContentKinds: generation.responseContentKinds,
                    stopReason: generation.stopReason,
                    outputTokens: generation.outputTokens,
                }),
                ...(promptSnapshots ? { promptSnapshots } : {}),
            });
        },
    };
}
function manualSubagentCapture(sessionId, checkpointState, logger) {
    if (!checkpointState)
        return {};
    return {
        captureSubagents: () => checkpointState.captureSubagents({ sessionId }),
        onSubagentCaptureFailure: () => logger?.error?.({
            event: 'context_compaction_subagent_checkpoint_capture_failed',
            session_id: sessionId,
        }, '[local-runtime-v2] subagent checkpoint state capture failed'),
    };
}
/**
 * Manual compaction commits without the final admission gate, so a replacement
 * larger than the original history is possible on short histories. The commit
 * stands (explicit user request); growth only leaves a content-free trace.
 */
function logManualReplacementGrowthBestEffort(logger, sessionId, decision, limits) {
    try {
        const { before, after } = decision.measurement;
        if (after.inputTokens <= before.inputTokens &&
            after.serializedBytes <= before.serializedBytes) {
            return;
        }
        logger?.warn?.({
            event: 'manual_compaction_replacement_grew',
            session_id: sessionId,
            method: decision.method,
            provider_input_limit: limits.providerInputLimit,
            before_input_tokens: before.inputTokens,
            before_serialized_bytes: before.serializedBytes,
            after_input_tokens: after.inputTokens,
            after_serialized_bytes: after.serializedBytes,
        }, '[local-runtime-v2] manual compaction replacement grew');
    }
    catch {
        // Observability must never change the compaction outcome.
    }
}
function completedManualCompaction(history, decision) {
    const completed = {
        status: 'completed',
        compactionId: `ctx_${randomUUID()}`,
        strategyVersion: 'local-context-compaction-v3',
        method: decision.method,
        replacementMessages: [...decision.replacementMessages],
        messagesBefore: history.length,
        messagesAfter: decision.replacementMessages.length,
        tokensBefore: decision.measurement.before.inputTokens,
        tokensAfter: decision.measurement.after.inputTokens,
        serializedBytesBefore: decision.measurement.before.serializedBytes,
        serializedBytesAfter: decision.measurement.after.serializedBytes,
        ...hmidRecoveryMetadata(decision),
        ...(decision.method === 'llm_checkpoint' && decision.tokenUsage !== undefined
            ? { tokenUsage: decision.tokenUsage }
            : {}),
    };
    return decision.method === 'llm_checkpoint'
        ? { ...completed, method: decision.method, summary: decision.summary }
        : {
            ...completed,
            method: decision.method,
            replacementSourceIndexes: history.map((_message, index) => index),
        };
}
function hmidRecoveryMetadata(decision) {
    return decision.method === 'llm_checkpoint' && decision.hmidOverflowRecovered
        ? { hmidOverflowRecovered: true }
        : {};
}
//# sourceMappingURL=local-context-compactor.js.map