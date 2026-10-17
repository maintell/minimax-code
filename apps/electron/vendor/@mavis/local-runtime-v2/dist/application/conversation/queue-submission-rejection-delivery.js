import { createUserMessageId, QueueServiceError, } from '../../service/session-system/index.js';
const INPUT_REJECTED_KIND = 'input_rejected';
const USER_MESSAGE_PREFIX = 'msg-user-v1-';
const ERROR_MESSAGE_PREFIX = 'msg-assistant-rejected-v1-';
/**
 * Persists a rejected inbound channel input as display-only history. It never
 * creates a Queue item, Turn, canonical history entry, or Session status edge.
 */
export function createQueueSubmissionRejectionDelivery(options) {
    const nowMs = options.nowMs ?? Date.now;
    return {
        find: async (submission) => {
            const ids = rejectionMessageIds(submission, submission.userMessageId);
            if (!ids || !(await readChannelSession(options, submission.sessionId)))
                return undefined;
            const error = await options.messages.get(submission.sessionId, ids.errorMessageId);
            return error ? rejectedModelError(error) : undefined;
        },
        record: async ({ submission, userMessageId, error }) => {
            const prepared = await prepareQueueSubmissionRejection(options, {
                submission,
                userMessageId,
                error,
                nowMs,
            });
            if (!prepared)
                return;
            reportModelRejected(options, submission, error);
            const result = await commitQueueSubmissionRejection(options, submission, error, prepared);
            if (!result.created)
                return;
            publishMessages(options, submission.sessionId, prepared.ids.errorMessageId, result.messages);
            publishAdmissionRejected(options, submission, prepared.displayError);
        },
    };
}
async function prepareQueueSubmissionRejection(options, input) {
    const { submission, userMessageId, error, nowMs } = input;
    if (error.reason !== 'model-invalid')
        return undefined;
    const session = await readChannelSession(options, submission.sessionId);
    if (!session)
        return undefined;
    const ids = rejectionMessageIds(submission, userMessageId);
    if (!ids)
        return undefined;
    const sourceContext = flattenedSourceContext(submission);
    return {
        ids,
        displayError: options.formatModelInvalid({
            agentName: session.agentName,
            ...(error.model ? { model: error.model } : {}),
            ...(error.modelSource ? { modelSource: error.modelSource } : {}),
        }),
        timestamp: Math.floor(nowMs()),
        ...(sourceContext ? { sourceContext } : {}),
        inputContent: submission.delivery?.displayContent ?? submission.input.text,
        attachments: displayAttachments(submission),
    };
}
async function commitQueueSubmissionRejection(options, submission, error, prepared) {
    try {
        return await options.messages.commitQueueSubmissionRejection({
            sessionId: submission.sessionId,
            user: {
                source: submission.provenance.source,
                ...(prepared.sourceContext ? { sourceContext: prepared.sourceContext } : {}),
                message: {
                    msg_id: prepared.ids.userMessageId,
                    role: 'user',
                    msg_type: 1,
                    msg_content: prepared.inputContent,
                    timestamp: prepared.timestamp,
                    kind: INPUT_REJECTED_KIND,
                    ...(prepared.attachments.length > 0 ? { attachments: prepared.attachments } : {}),
                },
            },
            error: {
                source: 'error',
                message: {
                    msg_id: prepared.ids.errorMessageId,
                    role: 'assistant',
                    msg_type: 1,
                    msg_content: prepared.displayError,
                    timestamp: prepared.timestamp,
                    kind: INPUT_REJECTED_KIND,
                    finish_reason: 'error',
                    raw_json: JSON.stringify(rejectedErrorPayload(submission, error, prepared.ids.userMessageId, prepared.displayError)),
                },
            },
        });
    }
    catch (writeError) {
        reportDisplayWriteFailure(options, submission, writeError);
        return { created: false, messages: [] };
    }
}
function rejectionMessageIds(submission, fallbackUserMessageId) {
    const key = stableSubmissionKey(submission);
    const userMessageId = key
        ? createUserMessageId({
            sessionId: submission.sessionId,
            messageKey: `queue-submission-rejected:${key}`,
        })
        : fallbackUserMessageId;
    if (!userMessageId?.startsWith(USER_MESSAGE_PREFIX))
        return undefined;
    return {
        userMessageId,
        errorMessageId: `${ERROR_MESSAGE_PREFIX}${userMessageId.slice(USER_MESSAGE_PREFIX.length)}`,
    };
}
function stableSubmissionKey(submission) {
    const dedupeKey = nonEmpty(submission.dedupeKey);
    if (dedupeKey)
        return `dedupeKey=${dedupeKey}`;
    const clientRequestId = nonEmpty(submission.clientRequestId);
    return clientRequestId ? `clientRequestId=${clientRequestId}` : undefined;
}
function rejectedModelError(message) {
    const payload = readRejectedModelPayload(message);
    if (!payload)
        return undefined;
    const text = rejectedModelErrorText(payload, message);
    if (!text)
        return undefined;
    return new QueueServiceError('model-invalid', text, rejectedModelErrorDetails(payload));
}
function readRejectedModelPayload(message) {
    if (!isRejectedAssistantMessage(message))
        return undefined;
    const payload = parseRecord(message.raw_json ?? message.rawJson);
    return payload?.code === 'model-invalid' ? payload : undefined;
}
function isRejectedAssistantMessage(message) {
    return message.kind === INPUT_REJECTED_KIND && message.role === 'assistant';
}
function rejectedModelErrorText(payload, message) {
    const text = nonEmpty(payload.message);
    return text ?? nonEmpty(message.msg_content);
}
function rejectedModelErrorDetails(payload) {
    const model = readModel(payload.model);
    const modelSource = readModelSource(payload.modelSource);
    return {
        ...(model ? { model } : {}),
        ...(modelSource ? { modelSource } : {}),
    };
}
function readModelSource(value) {
    return value === 'agent' || value === 'runtime-default' ? value : undefined;
}
function readModel(value) {
    const model = asRecord(value);
    const providerId = nonEmpty(model?.providerId);
    const modelId = nonEmpty(model?.modelId);
    return providerId && modelId ? { providerId, modelId } : undefined;
}
function rejectedErrorPayload(submission, error, userMessageId, displayError) {
    return {
        code: 'model-invalid',
        message: displayError,
        rejectedInputMessageId: userMessageId,
        ...(error.model ? { model: error.model } : {}),
        ...(error.modelSource ? { modelSource: error.modelSource } : {}),
        ...(nonEmpty(submission.clientRequestId)
            ? { clientRequestId: submission.clientRequestId }
            : {}),
        ...(nonEmpty(submission.dedupeKey) ? { dedupeKey: submission.dedupeKey } : {}),
    };
}
function displayAttachments(submission) {
    const attachments = submission.delivery?.displayAttachments ?? submission.input.attachments;
    return attachments?.map((attachment) => ({ ...attachment })) ?? [];
}
function flattenedSourceContext(submission) {
    const context = submission.provenance.sourceContext;
    if (!context)
        return undefined;
    const nested = context.channelContext;
    if (!nested || typeof nested !== 'object' || Array.isArray(nested))
        return { ...context };
    const outer = { ...context };
    delete outer.channelContext;
    return { ...outer, ...nested };
}
function reportModelRejected(options, submission, error) {
    try {
        options.onModelRejected?.({
            sessionId: submission.sessionId,
            ...rejectionCorrelation(submission),
            error,
        });
    }
    catch {
        // Error reporting cannot obscure the stable model-invalid admission result.
    }
}
function reportDisplayWriteFailure(options, submission, error) {
    try {
        options.onDisplayWriteFailure?.({
            sessionId: submission.sessionId,
            ...rejectionCorrelation(submission),
            error,
        });
    }
    catch {
        // The original model rejection must remain visible to the inbound adapter.
    }
}
function rejectionCorrelation(submission) {
    return {
        ...(nonEmpty(submission.clientRequestId)
            ? { clientRequestId: submission.clientRequestId }
            : {}),
        ...(nonEmpty(submission.dedupeKey) ? { dedupeKey: submission.dedupeKey } : {}),
    };
}
function publishMessages(options, sessionId, errorMessageId, messages) {
    try {
        options.stream.write({
            identity: `queue-submission-rejection:${errorMessageId}`,
            sessionId,
            kind: 'message-committed',
            data: { messages },
        });
    }
    catch {
        // The durable rows are replayed by Session stream resume and GetMessages.
    }
}
function publishAdmissionRejected(options, submission, error) {
    try {
        options.publish?.({
            type: 'session.queue.updated',
            payload: {
                sessionId: submission.sessionId,
                status: 'admission-rejected',
                reason: 'admission-rejected',
                source: submission.provenance.source,
                ...(nonEmpty(submission.clientRequestId)
                    ? { clientRequestId: submission.clientRequestId }
                    : {}),
                errorSource: 'model-invalid',
                error,
            },
        });
    }
    catch {
        // Global event delivery is observational; the durable display rows win.
    }
}
async function readChannelSession(options, sessionId) {
    const session = await options.sessions.get(sessionId);
    return session?.sessionKind === 'channel' ? session : undefined;
}
function parseRecord(value) {
    if (typeof value !== 'string')
        return undefined;
    try {
        return asRecord(JSON.parse(value));
    }
    catch {
        return undefined;
    }
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function nonEmpty(value) {
    return typeof value === 'string' && value.trim() ? value : undefined;
}
//# sourceMappingURL=queue-submission-rejection-delivery.js.map