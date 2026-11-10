import { randomUUID } from 'node:crypto';
import { DEFAULT_COMPACTION_SETTINGS } from '@earendil-works/pi-coding-agent/compaction';
import { hasThinkingPrefixBinding, } from '@mavis/agent-core/pi-turn-runner';
import { resolveCompactionTokenBudget } from '@mavis/context-manager';
import { compactContext, } from './algorithm/compact-context.js';
import { checkpointGenerationObservers, createCheckpointSession, } from './execution/checkpoint-provider.js';
import { resolveCheckpointSharedPrefix } from './execution/checkpoint-shared-prefix.js';
import { checkpointMaxOutputTokens } from './execution/checkpoint-prompt.js';
import { createLocalContextFootprintMeasurer, } from './execution/local-context-footprint.js';
import { ContextUsageAnchorState } from './execution/usage-anchor.js';
export class AutomaticContextCompactor {
    usageAnchor;
    checkpointState;
    logger;
    checkpointReminder;
    imageFileWriter;
    promptSnapshots;
    resolveEarlierFiles;
    checkpointRequestMessages;
    mainRequestMessages;
    getCompactionTriggerAt;
    constructor(usageAnchor, checkpointState, logger, dependencies) {
        this.usageAnchor = usageAnchor;
        this.checkpointState = checkpointState;
        this.logger = logger;
        this.checkpointReminder = dependencies.checkpointReminder;
        this.imageFileWriter = dependencies.imageFileWriter;
        this.promptSnapshots = dependencies.promptSnapshots;
        this.resolveEarlierFiles = dependencies.resolveEarlierFiles;
        this.checkpointRequestMessages = dependencies.checkpointRequestMessages;
        this.mainRequestMessages = dependencies.mainRequestMessages;
        this.getCompactionTriggerAt = dependencies.getCompactionTriggerAt;
    }
    probeBeforeLlm(input) {
        input.signal?.throwIfAborted();
        return {
            shouldStart: prepareAutomaticCompaction(input, this.usageAnchor, this.readCompactionTriggerAt()).shouldStart,
        };
    }
    async compactBeforeLlm(input, hooks) {
        input.signal?.throwIfAborted();
        const preparation = prepareAutomaticCompaction(input, this.usageAnchor, this.readCompactionTriggerAt());
        if (!preparation.shouldStart) {
            return { status: 'unchanged', reason: 'nothing-to-compact' };
        }
        await hooks?.onStarted();
        input.signal?.throwIfAborted();
        const decision = await runAutomaticPolicy({
            input,
            hooks,
            preparation,
            checkpointState: this.checkpointState,
            logger: this.logger,
            imageFileWriter: this.imageFileWriter,
            promptSnapshots: this.promptSnapshots,
            resolveEarlierFiles: this.resolveEarlierFiles,
            checkpointReminder: this.checkpointReminder,
            checkpointRequestMessages: this.checkpointRequestMessages,
            mainRequestMessages: this.mainRequestMessages,
        });
        this.usageAnchor?.invalidate(input.sessionId);
        return completedAutomaticCompaction(input, decision);
    }
    /** A failing config read degrades to the built-in trigger. */
    readCompactionTriggerAt() {
        try {
            return this.getCompactionTriggerAt?.();
        }
        catch {
            return undefined;
        }
    }
}
/**
 * A repeated request after a provider rejection always compacts, whatever the
 * measured footprint: the rejection proves the request is over a limit the
 * host could not measure. Every automatic compaction is an LLM checkpoint, so
 * the summary replaces the history (and every image in it) at once; history is
 * never rewritten piecewise, which would break prefix caches and thinking
 * signatures.
 * A model whose thinking is bound to its prefix has no request-byte trigger:
 * its requests keep every image, so a byte estimate would rewrite the prefix
 * before any rejection; an oversized request is rejected and recovered instead.
 */
function prepareAutomaticCompaction(input, usageAnchor, compactionTriggerAt) {
    const measurer = createAutomaticFootprintMeasurer(input, usageAnchor);
    const footprint = measurer.measure(input.messages);
    const { providerInputLimit, automaticTriggerAt } = resolveCompactionTokenBudget({
        contextWindow: input.model.contextWindow,
        configuredMaxOutputTokens: input.maxTokens ?? input.model.maxTokens,
        compactionTriggerAt,
    });
    return {
        measurer,
        footprint,
        shouldStart: input.recovery !== undefined ||
            footprint.inputTokens > automaticTriggerAt ||
            (!hasThinkingPrefixBinding(input.model) &&
                serializedBytesExceed(input, footprint.serializedBytes)),
        providerInputLimit,
    };
}
function serializedBytesExceed(input, serializedBytes) {
    return (input.maxSerializedInputBytes !== undefined && serializedBytes > input.maxSerializedInputBytes);
}
async function runAutomaticPolicy(options) {
    const { input, hooks, preparation, imageFileWriter, checkpointReminder, resolveEarlierFiles } = options;
    return compactContext({
        ...(checkpointReminder
            ? { checkpointReminder: (timestamp) => checkpointReminder(input.sessionId, timestamp) }
            : {}),
        history: input.messages,
        ...(resolveEarlierFiles
            ? { resolveEarlierFiles: () => resolveEarlierFiles(input.sessionId) }
            : {}),
        limits: automaticLimits(input, preparation.providerInputLimit),
        measurePair: async (pair) => preparation.measurer.measurePair(pair),
        ...(imageFileWriter
            ? {
                writeImageFile: (messages, image) => imageFileWriter.writeImageFile({ sessionId: input.sessionId, messages }, image),
            }
            : {}),
        checkpoint: automaticCheckpoint({
            input,
            hooks,
            tokensBefore: preparation.footprint.inputTokens,
            providerInputLimit: preparation.providerInputLimit,
            promptSnapshots: options.promptSnapshots,
            projectRequestMessages: options.checkpointRequestMessages,
            mainRequestMessages: options.mainRequestMessages,
        }),
        ...automaticSubagentCapture(input.sessionId, options.checkpointState, options.logger),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
}
function automaticLimits(input, providerInputLimit) {
    return {
        providerInputLimit,
        ...(input.maxSerializedInputBytes === undefined
            ? {}
            : { maxSerializedInputBytes: input.maxSerializedInputBytes }),
    };
}
function automaticCheckpoint({ input, hooks, tokensBefore, providerInputLimit, promptSnapshots, projectRequestMessages, mainRequestMessages, }) {
    return {
        tokensBefore,
        timestamp: Date.now(),
        ...(hooks?.onCheckpointAttemptSettled
            ? { onAttemptSettled: hooks.onCheckpointAttemptSettled }
            : {}),
        ...(hooks?.getProviderTokenUsage ? { getTokenUsage: hooks.getProviderTokenUsage } : {}),
        open: () => openAutomaticCheckpoint(input, hooks, providerInputLimit, {
            promptSnapshots,
            projectRequestMessages,
            mainRequestMessages,
        }),
    };
}
async function openAutomaticCheckpoint(input, hooks, providerInputLimit, context) {
    if (!input.streamFn) {
        throw new TypeError('Automatic context compaction requires streamFn.');
    }
    const session = await createCheckpointSession({
        projectRequestMessages: context.projectRequestMessages,
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
        ...(input.payloadTransform === undefined ? {} : { payloadTransform: input.payloadTransform }),
        ...(hooks?.onProviderRequestSettled
            ? { onRequestSettled: hooks.onProviderRequestSettled }
            : {}),
        ...sharedPrefixOption(input, context.mainRequestMessages),
        ...checkpointGenerationObservers(hooks),
        ...(context.promptSnapshots ? { promptSnapshots: context.promptSnapshots } : {}),
    });
    return session;
}
function sharedPrefixOption(input, mainRequestMessages) {
    const sharedPrefix = resolveCheckpointSharedPrefix(input, mainRequestMessages);
    return sharedPrefix ? { sharedPrefix } : {};
}
function automaticSubagentCapture(sessionId, checkpointState, logger) {
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
function completedAutomaticCompaction(input, decision) {
    const replacementMessages = [...decision.replacementMessages];
    return {
        status: 'completed',
        compactionId: `ctx_${randomUUID()}`,
        strategyVersion: 'local-context-compaction-v3',
        method: decision.method,
        summary: decision.summary,
        replacementMessages,
        messagesBefore: input.messages.length,
        messagesAfter: replacementMessages.length,
        tokensBefore: decision.measurement.before.inputTokens,
        tokensAfter: decision.measurement.after.inputTokens,
        serializedBytesBefore: decision.measurement.before.serializedBytes,
        serializedBytesAfter: decision.measurement.after.serializedBytes,
        ...(decision.hmidOverflowRecovered ? { hmidOverflowRecovered: true } : {}),
        ...(decision.tokenUsage !== undefined ? { tokenUsage: decision.tokenUsage } : {}),
    };
}
export function createAutomaticFootprintMeasurer(input, usageAnchor) {
    return createLocalContextFootprintMeasurer({
        model: input.model,
        ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
        ...(input.tools === undefined ? {} : { tools: input.tools }),
        ...(usageAnchor
            ? {
                usageAnchor: usageAnchor.bind({
                    scope: input.sessionId,
                    provider: input.model.provider,
                    api: input.model.api,
                    model: input.model.id,
                    ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
                    ...(input.tools === undefined ? {} : { tools: input.tools }),
                }),
            }
            : {}),
    });
}
//# sourceMappingURL=automatic-context-compactor.js.map