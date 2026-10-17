import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { isInlineDisplayDataUrl, sanitizeDisplayAttachment, QueueServiceError, } from '../session-system/index.js';
import { queueModelFromAgentHost } from './agent-host/index.js';
import { createUserMessageId } from '../session-system/shared/user-message-id.js';
import { resolveGenuineUserQueryText } from './execution/message-query-authorship.js';
import { sessionClioQueuedQueryId } from '../session-clio/query-identity.js';
/** Owns immediate-vs-queued submit semantics above pure Turn execution. */
export function createTurnSubmissionService(options) {
    const makeTurnId = options.makeTurnId ?? (() => `turn_${randomUUID()}`);
    return {
        submit: (input) => input.allowQueue
            ? submitQueued(options, input, makeTurnId)
            : submitImmediate(options, input, makeTurnId),
        resumeUserInput: (input) => resumeUserInput(options, input, makeTurnId),
    };
}
async function resumeUserInput(options, input, makeTurnId) {
    const requestId = input.resume.requestId.trim();
    if (!requestId || requestId !== input.resume.requestId) {
        return { accepted: false, reason: 'invalid-input' };
    }
    // This is a continuation of an already admitted user-input request. Its
    // queued/runtime snapshot remains authoritative; do not reread the Agent.
    const resolved = input;
    const identity = `user-input-resume:${input.resume.kind}:${requestId}`;
    const userMessageId = input.userMessageId ??
        createUserMessageId({ sessionId: input.sessionId, messageKey: identity });
    return options.activation.execute({
        sessionId: resolved.sessionId,
        input: resolved.input,
        ...(resolved.inputSafetyDecision ? { inputSafetyDecision: resolved.inputSafetyDecision } : {}),
        provenance: resolved.provenance,
        requestedTurnId: resolved.requestedTurnId ?? makeTurnId(),
        userMessageId,
        clientRequestId: identity,
        admissionPriority: { kind: 'user-input-resume' },
        resume: resolved.resume,
        delivery: { ...resolved.delivery, messageKey: identity, userMessageId },
    });
}
async function submitImmediate(options, input, makeTurnId) {
    await throwPriorSubmissionRejection(options, input);
    const requestedTurnId = input.requestedTurnId ?? makeTurnId();
    const messageKey = input.delivery?.messageKey ?? `turn:${requestedTurnId}`;
    const userMessageId = input.userMessageId ?? createUserMessageId({ sessionId: input.sessionId, messageKey });
    const resolved = await resolveImmediateInput(options, input, userMessageId);
    const result = await options.activation.execute({
        sessionId: resolved.sessionId,
        input: resolved.input,
        ...(resolved.outputContract ? { outputContract: resolved.outputContract } : {}),
        ...(resolved.executionDeadlineAtMs !== undefined
            ? { executionDeadlineAtMs: resolved.executionDeadlineAtMs }
            : {}),
        ...(resolved.inputSafetyDecision ? { inputSafetyDecision: resolved.inputSafetyDecision } : {}),
        provenance: resolved.provenance,
        requestedTurnId,
        userMessageId,
        ...(resolved.clientRequestId ? { clientRequestId: resolved.clientRequestId } : {}),
        ...(resolved.clientIntent ? { clientIntent: resolved.clientIntent } : {}),
        ...directSubmissionPriority(resolved),
        delivery: { ...resolved.delivery, userMessageId },
    });
    return result.accepted ? { ...result, mode: 'started' } : result;
}
async function resolveChannelInputModel(options, input) {
    const model = await options.resolveChannelInputModel?.({
        sessionId: input.sessionId,
        input: input.input,
        provenance: input.provenance,
    });
    return model === undefined ? input : { ...input, input: { ...input.input, model } };
}
async function resolveImmediateInput(options, input, userMessageId) {
    try {
        return await resolveChannelInputModel(options, input);
    }
    catch (error) {
        await recordModelSubmissionRejection(options, input, userMessageId, error);
        throw error;
    }
}
async function throwPriorSubmissionRejection(options, input) {
    const priorRejection = await options.queueSubmissionRejections?.find(input);
    if (priorRejection)
        throw priorRejection;
}
async function recordModelSubmissionRejection(options, submission, userMessageId, error) {
    if (!(error instanceof QueueServiceError) || error.reason !== 'model-invalid')
        return;
    try {
        await options.queueSubmissionRejections?.record({ submission, userMessageId, error });
    }
    catch {
        // The production delivery reports a display_write_failed diagnostic. The
        // original model-invalid error remains the inbound adapter's reply fact.
    }
}
function directSubmissionPriority(input) {
    if (input.resumePausedQueue)
        return { admissionPriority: { kind: 'paused-queue-send' } };
    return input.clientIntent === 'retry-continuation'
        ? { admissionPriority: { kind: 'retry-continuation' } }
        : {};
}
async function submitQueued(options, input, makeTurnId) {
    const source = validQueueSource(input);
    if (!source)
        return { accepted: false, reason: 'invalid-input' };
    await throwPriorSubmissionRejection(options, input);
    const requestedTurnId = input.requestedTurnId ?? makeTurnId();
    const activeTurnIdAtAdmission = options.activeTurnId(input.sessionId);
    const messageKey = input.delivery?.messageKey ?? `turn:${requestedTurnId}`;
    const userMessageId = input.userMessageId ?? createUserMessageId({ sessionId: input.sessionId, messageKey });
    let completion = options.completions.register(requestedTurnId, input.sessionId);
    let committed;
    try {
        const session = await options.queue.requireMutableSession(input.sessionId);
        committed = await options.queue.enqueue(toQueueInput(input, { requestedTurnId, userMessageId, agentName: session.agentName, source }));
    }
    catch (error) {
        options.completions.discard(requestedTurnId);
        await recordModelSubmissionRejection(options, input, userMessageId, error);
        throw error;
    }
    if (!committed) {
        options.completions.discard(requestedTurnId);
        return { accepted: false, reason: 'invalid-input' };
    }
    const turnId = committed.item.requestedTurnId ?? requestedTurnId;
    completion = rebindCompletion(options, completion, {
        requestedTurnId,
        turnId,
        sessionId: input.sessionId,
    });
    options.completions.bind(turnId, committed.item.itemId);
    await admitQueuedSessionClioQuery(options, input, committed.item);
    await dispatchBestEffort(options, input.sessionId);
    const ahead = await queuedWorkAhead(options, {
        sessionId: input.sessionId,
        itemId: committed.item.itemId,
        turnId,
        admittedPosition: committed.position,
        activeTurnIdAtAdmission,
    });
    return {
        accepted: true,
        mode: 'queued',
        turnId,
        completion,
        queue: {
            itemId: committed.item.itemId,
            position: committed.position,
            ahead,
        },
    };
}
function validQueueSource(input) {
    if (input.outputContract ||
        input.executionDeadlineAtMs !== undefined ||
        input.delivery?.onAccepted ||
        input.delivery?.beforeStart) {
        return undefined;
    }
    return queueSource(input.provenance.source);
}
function rebindCompletion(options, completion, identity) {
    if (identity.turnId === identity.requestedTurnId)
        return completion;
    options.completions.discard(identity.requestedTurnId);
    return options.completions.register(identity.turnId, identity.sessionId);
}
async function dispatchBestEffort(options, sessionId) {
    try {
        await options.dispatcher.dispatch(sessionId);
    }
    catch (error) {
        reportWakeFailure(options, sessionId, error);
    }
}
/**
 * Records a queued Query at the durable enqueue that admitted it, stamped with
 * the item's own creation time rather than the later dispatch instant.
 */
async function admitQueuedSessionClioQuery(options, input, item) {
    const clio = options.sessionClio;
    if (!clio)
        return;
    await clio.admitQuery({
        sessionId: input.sessionId,
        queryId: sessionClioQueuedQueryId(item.itemId),
        genuineUserQueryText: resolveGenuineUserQueryText({
            input: input.input,
            provenance: input.provenance,
            ...(input.delivery ? { delivery: input.delivery } : {}),
        }),
        originalInstructionText: input.input.text,
        source: input.provenance.source,
        occurredAtMs: item.createdAt,
    });
}
function toQueueInput(input, values) {
    return {
        session: { sessionId: input.sessionId, agentName: values.agentName },
        requestedTurnId: values.requestedTurnId,
        userMessageId: values.userMessageId,
        // Review is still an interactive API queue row. Its execution provenance
        // lives on the nested message so the composer can keep managing the row.
        source: values.source === 'code_review' ? 'api' : values.source,
        ...(input.queuePlacement ? { queuePlacement: input.queuePlacement } : {}),
        message: toQueueMessage(input),
        ...toQueueModel(input.input.model),
        ...toQueueMetadata(input),
    };
}
function toQueueMessage(input) {
    const channelContext = toQueueChannelContext(input);
    return {
        content: input.input.text,
        attachments: (input.input.attachments ?? []).flatMap(toQueueAttachment),
        ...(input.input.computerUse ? { computerUse: { enable: input.input.computerUse.enable } } : {}),
        ...(input.inputSafetyDecision ? { inputSafetyDecision: input.inputSafetyDecision } : {}),
        ...toQueueDeliveryMetadata(input),
        ...toQueueCanonicalMetadata(input),
        ...(input.clientIntent ? { clientIntent: input.clientIntent } : {}),
        ...(input.provenance.source === 'code_review' ? { source: 'code_review' } : {}),
        ...(channelContext ? { channelContext } : {}),
    };
}
function toQueueDeliveryMetadata(input) {
    return {
        ...(input.delivery?.hideUserMessage !== undefined
            ? { hideUserMessage: input.delivery.hideUserMessage }
            : {}),
        ...(input.delivery?.displayContent !== undefined
            ? { displayContent: input.delivery.displayContent }
            : {}),
        ...(input.delivery?.displayAttachments
            ? {
                displayAttachments: input.delivery.displayAttachments.map((attachment) => sanitizeDisplayAttachment(attachment)),
            }
            : {}),
    };
}
async function queuedWorkAhead(options, input) {
    try {
        const [pending, exact] = await Promise.all([
            options.queue.list(input.sessionId),
            options.queue.get(input.sessionId, input.itemId),
        ]);
        const activeTurnId = options.activeTurnId(input.sessionId);
        const pendingIndex = pending.findIndex((item) => item.itemId === input.itemId);
        if (pendingIndex >= 0)
            return pendingIndex + (activeTurnId ? 1 : 0);
        if (exact?.status === 'claimed') {
            return activeTurnId && activeTurnId !== input.turnId ? 1 : 0;
        }
        return 0;
    }
    catch {
        return (Math.max(0, input.admittedPosition - 1) +
            (input.activeTurnIdAtAdmission && input.activeTurnIdAtAdmission !== input.turnId ? 1 : 0));
    }
}
function toQueueCanonicalMetadata(input) {
    const origin = input.provenance.sourceContext?.origin ?? input.input.origin;
    return {
        ...(origin !== undefined ? { origin } : {}),
        ...(input.input.quotedMessage ? { quotedMessage: { ...input.input.quotedMessage } } : {}),
    };
}
function toQueueModel(model) {
    const override = queueModelFromAgentHost(model);
    return override ? { model: override } : {};
}
function toQueueMetadata(input) {
    return {
        ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
        ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    };
}
function toQueueAttachment(input) {
    const filePath = input.filePath?.trim() ?? '';
    const candidateDataUrl = input.dataUrl?.trim();
    const inlineDataUrl = isInlineDisplayDataUrl(candidateDataUrl);
    if (inlineDataUrl && !filePath) {
        throw new TypeError('Inline attachment must be registered before Queue admission.');
    }
    const dataUrl = inlineDataUrl ? undefined : candidateDataUrl;
    if (!hasQueueAttachmentPayload(input, filePath, dataUrl))
        return [];
    const attachment = {
        ...queueAttachmentMetadata(input, filePath),
        filePath,
        ...(dataUrl ? { dataUrl } : {}),
        ...(input.assetId ? { assetId: input.assetId } : {}),
        ...(input.error ? { error: input.error } : {}),
    };
    return [attachment];
}
function hasQueueAttachmentPayload(input, filePath, dataUrl) {
    return Boolean(filePath || dataUrl || input.assetId || input.error);
}
function queueAttachmentMetadata(input, filePath) {
    const mimeType = input.mimeType?.trim() ?? '';
    return {
        type: input.type === 'image' || mimeType.startsWith('image/') ? 'image' : 'file',
        fileName: input.fileName?.trim() || basename(filePath) || 'attachment',
        mimeType,
    };
}
function toQueueChannelContext(input) {
    const context = provenanceChannelContext(input);
    const fallback = input.input.channelContext;
    const platform = channelField(context, fallback?.platform, 'platform');
    const chatId = channelField(context, fallback?.chatId, 'chatId');
    const senderId = channelField(context, fallback?.senderId, 'senderId');
    const targetAgentId = channelField(context, fallback?.targetAgentId, 'targetAgentId');
    if (!platform || !chatId || !senderId)
        return undefined;
    return {
        ...(context ?? {}),
        platform,
        chatType: channelField(context, fallback?.chatType, 'chatType') ?? 'private',
        chatId,
        senderId,
        clientName: channelField(context, fallback?.clientName, 'clientName') ?? platform,
        ...(targetAgentId ? { targetAgentId } : {}),
    };
}
function provenanceChannelContext(input) {
    const nested = input.provenance.sourceContext?.channelContext;
    return nested && typeof nested === 'object' && !Array.isArray(nested)
        ? nested
        : input.provenance.sourceContext;
}
function channelField(context, fallback, key) {
    return readString(context, key) ?? fallback;
}
function readString(value, key) {
    const field = value?.[key];
    return typeof field === 'string' && field.trim() ? field : undefined;
}
function queueSource(value) {
    return QUEUE_SOURCES.has(value) ? value : undefined;
}
function reportWakeFailure(options, sessionId, error) {
    try {
        options.onQueueWakeFailure?.({ sessionId, error });
    }
    catch {
        // Durable Queue admission remains authoritative when diagnostics fail.
    }
}
const QUEUE_SOURCES = new Set([
    'api',
    'cron',
    'task',
    'background-task',
    'team',
    'thread-goal',
    'questionnaire',
    'communication',
    'code_review',
    'greeting',
    'channel:wechat',
    'channel:feishu',
    'channel:telegram',
]);
//# sourceMappingURL=turn-submission.service.js.map