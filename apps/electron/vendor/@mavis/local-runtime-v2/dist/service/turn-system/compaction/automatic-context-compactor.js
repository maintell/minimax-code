import { randomUUID } from 'node:crypto';
import { DEFAULT_COMPACTION_SETTINGS } from '@earendil-works/pi-coding-agent/compaction';
import { keepsRequestImages, listRequestImages, } from '@mavis/agent-core/pi-turn-runner';
import { resolveCompactionTokenBudget, withoutThinking } from '@mavis/context-manager';
import { compactContext, } from './algorithm/compact-context.js';
import { ToolResultArchiver, } from './algorithm/tool-result-archiver.js';
import { checkpointGenerationObservers, createCheckpointSession, } from './execution/checkpoint-provider.js';
import { resolveCheckpointSharedPrefix } from './execution/checkpoint-shared-prefix.js';
import { checkpointMaxOutputTokens } from './execution/checkpoint-prompt.js';
import { projectRequestMedia } from './execution/request-media-projection.js';
import { createLocalContextFootprintMeasurer } from './execution/local-context-footprint.js';
import { ContextUsageAnchorState } from './execution/usage-anchor.js';
export class AutomaticContextCompactor {
    usageAnchor;
    checkpointState;
    logger;
    checkpointReminder;
    toolResultArchiver;
    promptSnapshots;
    resolveEarlierFiles;
    checkpointRequestMessages;
    getCompactionTriggerAt;
    constructor(usageAnchor, checkpointState, logger, dependencies) {
        this.usageAnchor = usageAnchor;
        this.checkpointState = checkpointState;
        this.logger = logger;
        this.checkpointReminder = dependencies.checkpointReminder;
        this.toolResultArchiver = dependencies.toolResultArchiver;
        this.promptSnapshots = dependencies.promptSnapshots;
        this.resolveEarlierFiles = dependencies.resolveEarlierFiles;
        this.checkpointRequestMessages = dependencies.checkpointRequestMessages;
        this.getCompactionTriggerAt = dependencies.getCompactionTriggerAt;
    }
    probeBeforeLlm(input) {
        input.signal?.throwIfAborted();
        return {
            shouldStart: prepareAutomaticCompaction(input, this.usageAnchor, this.toolResultArchiver, this.readCompactionTriggerAt()).shouldStart,
        };
    }
    async compactBeforeLlm(input, hooks) {
        input.signal?.throwIfAborted();
        const preparation = prepareAutomaticCompaction(input, this.usageAnchor, this.toolResultArchiver, this.readCompactionTriggerAt());
        if (!preparation.shouldStart) {
            return { status: 'unchanged', reason: 'nothing-to-compact' };
        }
        await hooks?.onStarted();
        input.signal?.throwIfAborted();
        const toolResultCompactionCandidate = await materializeToolResultCompactionBestEffort(this.toolResultArchiver, input, preparation);
        input.signal?.throwIfAborted();
        if (!toolResultCompactionCandidate && !preparation.normalTriggerMatched) {
            return { status: 'unchanged', reason: 'nothing-to-compact' };
        }
        const decision = await runAutomaticPolicy({
            input,
            hooks,
            preparation,
            toolResultCompactionCandidate,
            checkpointState: this.checkpointState,
            logger: this.logger,
            archiver: this.toolResultArchiver,
            promptSnapshots: this.promptSnapshots,
            resolveEarlierFiles: this.resolveEarlierFiles,
            checkpointReminder: this.checkpointReminder,
            checkpointRequestMessages: this.checkpointRequestMessages,
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
 * host could not measure, and it is the only compaction that moves images out
 * of history (all of them, user attachments and tool results alike, leaving a
 * line naming each file). Trigger-based compaction leaves images in place.
 * After the images and older tool outputs leave, the recovery always ends in
 * an LLM checkpoint, so a rejected request is never repeated on a history that
 * merely fits the local estimate.
 * Prefix-cached models have no request-byte trigger: their requests keep every
 * image, so a byte estimate would rewrite the prefix before any rejection; an
 * oversized request is rejected and recovered instead. Past the token trigger
 * they checkpoint directly instead of archiving tool outputs first, so the
 * prefix is rewritten once by the summary.
 */
function prepareAutomaticCompaction(input, usageAnchor, archiver, compactionTriggerAt) {
    const measurer = createAutomaticFootprintMeasurer(input, usageAnchor);
    const footprint = measurer.measure(input.messages);
    const { providerInputLimit, automaticTriggerAt } = resolveCompactionTokenBudget({
        contextWindow: input.model.contextWindow,
        configuredMaxOutputTokens: input.maxTokens ?? input.model.maxTokens,
        compactionTriggerAt,
    });
    const toolResultCompactionPlan = archiver?.plan({
        sessionId: input.sessionId,
        messages: input.messages,
    });
    const recovering = input.recovery !== undefined;
    const prefixCached = keepsRequestImages(input.model);
    const tokenTriggerMatched = footprint.inputTokens > automaticTriggerAt;
    const normalTriggerMatched = recovering ||
        tokenTriggerMatched ||
        (!prefixCached && serializedBytesExceed(input, footprint.serializedBytes));
    return {
        measurer,
        footprint,
        toolResultCompactionPlan,
        archivesImages: archiver !== undefined && recovering && listRequestImages(input.messages).length > 0,
        checkpointRequired: recovering || (tokenTriggerMatched && prefixCached),
        canReadArchivedToolResults: hasReadTool(input.tools),
        normalTriggerMatched,
        shouldStart: toolResultCompactionPlan !== undefined || normalTriggerMatched,
        providerInputLimit,
    };
}
function serializedBytesExceed(input, serializedBytes) {
    return (input.maxSerializedInputBytes !== undefined && serializedBytes > input.maxSerializedInputBytes);
}
async function runAutomaticPolicy(options) {
    const { input, hooks, preparation, archiver, checkpointReminder, resolveEarlierFiles } = options;
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
        ...(options.toolResultCompactionCandidate
            ? { toolResultCompactionCandidate: options.toolResultCompactionCandidate }
            : {}),
        allowLegacyToolTrim: archiver === undefined,
        checkpointRequired: preparation.checkpointRequired,
        ...(archiver
            ? {
                writeImageFile: (messages, image) => archiver.writeImageFile({ sessionId: input.sessionId, messages }, image),
            }
            : {}),
        checkpoint: automaticCheckpoint({
            input,
            hooks,
            tokensBefore: preparation.footprint.inputTokens,
            providerInputLimit: preparation.providerInputLimit,
            promptSnapshots: options.promptSnapshots,
            projectRequestMessages: options.checkpointRequestMessages,
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
function automaticCheckpoint({ input, hooks, tokensBefore, providerInputLimit, promptSnapshots, projectRequestMessages, }) {
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
        ...sharedPrefixOption(input),
        ...checkpointGenerationObservers(hooks),
        ...(context.promptSnapshots ? { promptSnapshots: context.promptSnapshots } : {}),
    });
    return session;
}
function sharedPrefixOption(input) {
    const sharedPrefix = resolveCheckpointSharedPrefix(input);
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
    const { messages } = input;
    // tool_archive and tool_trim keep the earlier assistant turns but rewrite
    // messages between them, so their thinking signatures no longer match the
    // prefix. llm_checkpoint replaces the history with a summary and keeps no turn.
    const replacementMessages = decision.method !== 'llm_checkpoint' && keepsRequestImages(input.model)
        ? withoutThinking(decision.replacementMessages)
        : [...decision.replacementMessages];
    const completed = {
        status: 'completed',
        compactionId: `ctx_${randomUUID()}`,
        strategyVersion: 'local-context-compaction-v3',
        method: decision.method,
        replacementMessages,
        messagesBefore: messages.length,
        messagesAfter: replacementMessages.length,
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
            replacementSourceIndexes: messages.map((_message, index) => index),
        };
}
function hmidRecoveryMetadata(decision) {
    return decision.method === 'llm_checkpoint' && decision.hmidOverflowRecovered
        ? { hmidOverflowRecovered: true }
        : {};
}
function hasReadTool(tools) {
    return tools?.some((tool) => tool.name === 'read') === true;
}
async function materializeToolResultCompactionBestEffort(archiver, input, preparation) {
    if (!archiver)
        return undefined;
    const { sessionId } = input;
    const plan = preparation.toolResultCompactionPlan;
    try {
        let text;
        if (plan) {
            text = preparation.canReadArchivedToolResults
                ? await archiver.materialize({ sessionId, plan })
                : await archiver.materializeTrim({ sessionId, plan });
        }
        const images = preparation.archivesImages
            ? await archiver.archiveImages({ sessionId, messages: text?.messages ?? input.messages })
            : undefined;
        return images ? withArchivedImages(text, images) : text;
    }
    catch {
        return undefined;
    }
}
function withArchivedImages(text, images) {
    const actualSavingsBytes = (text?.actualSavingsBytes ?? 0) + images.savedBytes;
    if (text && 'trimmedResultCount' in text) {
        return {
            messages: images.messages,
            trimmedResultCount: text.trimmedResultCount + images.archivedImageCount,
            actualSavingsBytes,
        };
    }
    return {
        messages: images.messages,
        archivedResultCount: (text?.archivedResultCount ?? 0) + images.archivedImageCount,
        actualSavingsBytes,
    };
}
/**
 * Request-only image limit for every image, user or tool, on models that do
 * not cache by prefix. Runs after compaction, so its placeholders never reach
 * durable history. A repeated request needs nothing more: compaction has
 * already moved every image out of history. Prefix-cached models skip it, so
 * their requests stay byte-identical until a compaction replaces the history.
 * The projection itself is `projectRequestMedia`, shared with the shared-prefix
 * checkpoint request.
 */
export function createRequestMediaGuardHook() {
    return (input) => {
        const { messages, omittedCount } = projectRequestMedia(input);
        return omittedCount === 0
            ? { type: 'continue' }
            : { type: 'replaceRequestMessages', messages, reason: 'request-media-guard' };
    };
}
export function createAutomaticContextRequestFilterHook(projectRequestMessages) {
    return (input) => {
        const messages = projectRequestMessages?.(input.sessionId, input.messages) ?? input.messages;
        return messages.length === input.messages.length
            ? { type: 'continue' }
            : {
                type: 'replaceRequestMessages',
                messages: [...messages],
                reason: 'internal-context-filter',
            };
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