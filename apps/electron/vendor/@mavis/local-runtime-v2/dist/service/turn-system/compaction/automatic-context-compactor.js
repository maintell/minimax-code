import { randomUUID } from 'node:crypto';
import { DEFAULT_COMPACTION_SETTINGS } from '@earendil-works/pi-coding-agent/compaction';
import { resolveCompactionTokenBudget } from '@mavis/context-manager';
import { compactContext, } from './algorithm/compact-context.js';
import { ToolResultArchiver, } from './algorithm/tool-result-archiver.js';
import { createCheckpointSession } from './execution/checkpoint-provider.js';
import { checkpointMaxOutputTokens } from './execution/checkpoint-prompt.js';
import { createLocalContextFootprintMeasurer } from './execution/local-context-footprint.js';
import { ContextUsageAnchorState } from './execution/usage-anchor.js';
export class AutomaticContextCompactor {
    usageAnchor;
    checkpointState;
    logger;
    toolResultArchiver;
    promptSnapshots;
    constructor(usageAnchor, checkpointState, logger, dependencies) {
        this.usageAnchor = usageAnchor;
        this.checkpointState = checkpointState;
        this.logger = logger;
        this.toolResultArchiver = dependencies.toolResultArchiver;
        this.promptSnapshots = dependencies.promptSnapshots;
    }
    probeBeforeLlm(input) {
        input.signal?.throwIfAborted();
        return {
            shouldStart: prepareAutomaticCompaction(input, this.usageAnchor, this.toolResultArchiver)
                .shouldStart,
        };
    }
    async compactBeforeLlm(input, hooks) {
        input.signal?.throwIfAborted();
        const preparation = prepareAutomaticCompaction(input, this.usageAnchor, this.toolResultArchiver);
        if (!preparation.shouldStart) {
            return { status: 'unchanged', reason: 'nothing-to-compact' };
        }
        await hooks?.onStarted();
        input.signal?.throwIfAborted();
        const toolResultCompactionCandidate = await materializeToolResultCompactionBestEffort(this.toolResultArchiver, input.sessionId, preparation.toolResultCompactionPlan, preparation.canReadArchivedToolResults);
        input.signal?.throwIfAborted();
        if (preparation.toolResultCompactionPlan &&
            !toolResultCompactionCandidate &&
            !preparation.normalTriggerMatched) {
            return { status: 'unchanged', reason: 'nothing-to-compact' };
        }
        const decision = await runAutomaticPolicy({
            input,
            hooks,
            preparation,
            toolResultCompactionCandidate,
            checkpointState: this.checkpointState,
            logger: this.logger,
            legacyToolTrim: this.toolResultArchiver === undefined,
            promptSnapshots: this.promptSnapshots,
        });
        this.usageAnchor?.invalidate(input.sessionId);
        return completedAutomaticCompaction(input.messages, decision);
    }
}
function prepareAutomaticCompaction(input, usageAnchor, archiver) {
    const measurer = createAutomaticFootprintMeasurer(input, usageAnchor);
    const footprint = measurer.measure(input.messages);
    const { providerInputLimit, automaticTriggerAt } = resolveCompactionTokenBudget({
        contextWindow: input.model.contextWindow,
        configuredMaxOutputTokens: input.maxTokens ?? input.model.maxTokens,
    });
    const toolResultCompactionPlan = archiver?.plan({
        sessionId: input.sessionId,
        messages: input.messages,
    });
    const normalTriggerMatched = footprint.inputTokens > automaticTriggerAt ||
        (input.maxSerializedInputBytes !== undefined &&
            footprint.serializedBytes > input.maxSerializedInputBytes);
    return {
        measurer,
        footprint,
        toolResultCompactionPlan,
        canReadArchivedToolResults: hasReadTool(input.tools),
        normalTriggerMatched,
        shouldStart: toolResultCompactionPlan !== undefined || normalTriggerMatched,
        providerInputLimit,
    };
}
async function runAutomaticPolicy(options) {
    const { input, hooks, preparation } = options;
    return compactContext({
        history: input.messages,
        limits: automaticLimits(input, preparation.providerInputLimit),
        measurePair: async (pair) => preparation.measurer.measurePair(pair),
        ...(options.toolResultCompactionCandidate
            ? { toolResultCompactionCandidate: options.toolResultCompactionCandidate }
            : {}),
        allowLegacyToolTrim: options.legacyToolTrim,
        checkpoint: automaticCheckpoint({
            input,
            hooks,
            tokensBefore: preparation.footprint.inputTokens,
            providerInputLimit: preparation.providerInputLimit,
            promptSnapshots: options.promptSnapshots,
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
function automaticCheckpoint({ input, hooks, tokensBefore, providerInputLimit, promptSnapshots, }) {
    return {
        tokensBefore,
        timestamp: Date.now(),
        ...(hooks?.onCheckpointAttemptSettled
            ? { onAttemptSettled: hooks.onCheckpointAttemptSettled }
            : {}),
        ...(hooks?.getProviderTokenUsage ? { getTokenUsage: hooks.getProviderTokenUsage } : {}),
        open: () => openAutomaticCheckpoint(input, hooks, providerInputLimit, promptSnapshots),
    };
}
async function openAutomaticCheckpoint(input, hooks, providerInputLimit, promptSnapshots) {
    if (!input.streamFn) {
        throw new TypeError('Automatic context compaction requires streamFn.');
    }
    const session = await createCheckpointSession({
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
        onGenerated: (generation) => hooks?.onCheckpointGenerated?.({
            responseContentKinds: generation.responseContentKinds,
            stopReason: generation.stopReason,
            outputTokens: generation.outputTokens,
        }),
        ...(promptSnapshots ? { promptSnapshots } : {}),
    });
    const measure = session.measure;
    return {
        ...session,
        fits: (request) => session.fits({
            ...request,
            messages: projectAutomaticContextRequestMessages(request.messages),
        }),
        ...(measure === undefined
            ? {}
            : {
                measure: (request) => measure({
                    ...request,
                    messages: projectAutomaticContextRequestMessages(request.messages),
                }),
            }),
        generate: async (request) => await session.generate({
            ...request,
            messages: projectAutomaticContextRequestMessages(request.messages),
        }),
    };
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
function completedAutomaticCompaction(messages, decision) {
    const completed = {
        status: 'completed',
        compactionId: `ctx_${randomUUID()}`,
        strategyVersion: 'local-context-compaction-v3',
        method: decision.method,
        replacementMessages: [...decision.replacementMessages],
        messagesBefore: messages.length,
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
async function materializeToolResultCompactionBestEffort(archiver, sessionId, plan, canReadArchivedToolResults) {
    if (!archiver || !plan)
        return undefined;
    try {
        return canReadArchivedToolResults
            ? await archiver.materialize({ sessionId, plan })
            : await archiver.materializeTrim({ sessionId, plan });
    }
    catch {
        return undefined;
    }
}
export function createAutomaticContextRequestFilterHook() {
    return (input) => {
        const messages = projectAutomaticContextRequestMessages(input.messages);
        return messages === input.messages
            ? { type: 'continue' }
            : {
                type: 'replaceRequestMessages',
                messages: [...messages],
                reason: 'internal-context-filter',
            };
    };
}
function projectAutomaticContextRequestMessages(messages) {
    return messages;
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