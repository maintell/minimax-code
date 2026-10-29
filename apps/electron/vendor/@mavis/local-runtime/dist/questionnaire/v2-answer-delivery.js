import { ConversationTurnRejectedError, } from '@mavis/conversation-contract';
import { isOrdinaryQuestionnaireResponseOrigin, QUESTIONNAIRE_ANSWER_STEERING_PRODUCER, } from '@mavis/shared/questionnaire';
import { logger } from '../common/logger.js';
import { LocalQuestionnaireError } from './errors.js';
import { serializeQuestionnaireResponseMessage } from './serializer.js';
import { questionnaireImageEntries, recoverQuestionnaireImageAttachments, } from './context-images.js';
import { publishQuestionnaireState } from './v2-state.js';
/** Same identity as the legacy reply queue item, so the queue dedupes both paths. */
export function v2AnswerIdentity(requestId) {
    return `questionnaire-reply:${requestId}`;
}
/** Rejections that mean "this session will never take the answer"; everything else queues. */
const TERMINAL_REJECTIONS = new Set(['invalid-session', 'invalid-input', 'session-deleting']);
/**
 * Hands a persisted v2 answer to the model:
 * 1. the sync ask_user call still waits for it: the answer becomes the tool
 *    result and `injected_at` is written now;
 * 2. otherwise steer: joins the running Turn, or starts one when idle. A
 *    started Turn (activated) has the answer as its durable input, so it is
 *    injected now. A joined Turn (steered) only holds it in memory until the
 *    model consumes it; `injected_at` is written by the v2 Turn system at
 *    consumption, or when a Stopped Turn's teardown commits it into the
 *    conversation (it is never dropped: see isTeardownDurableSteeringProducer);
 * 3. the session is idle but cannot start a Turn (Plan card awaiting a
 *    decision, compaction, ...): queue at the front without failing;
 *    `injected_at` stays empty until the Turn that carries it is admitted
 *    (see `markV2AnswerAdmitted`).
 */
export async function deliverV2Answer(deps, record, reply, options) {
    const fields = {
        requestId: record.requestId,
        sessionId: record.sessionId,
        responseMode: record.responseMode,
    };
    // Retries must not steer a second copy while the original call prepares images.
    if (deps.syncWaits?.isDeliveringAnswer(record.requestId))
        return 'tool_result';
    const settlement = options.allowToolResult
        ? deps.syncWaits?.settleAnswered(record.requestId, reply)
        : undefined;
    if (settlement === 'delivered') {
        // Image preparation can yield or fail: the adapter acknowledges only after it
        // has built the result, so Stop/restart can recover an undelivered answer.
        if (!questionnaireImageEntries(reply).length) {
            await markV2Injected(deps, record.requestId, 'tool_result');
        }
        logger.info({ ...fields, delivery: 'tool_result' }, 'Questionnaire v2 answer delivered');
        return 'tool_result';
    }
    if (settlement === 'buffered') {
        // The ask_user call has not started waiting yet; it takes the answer from
        // the buffer and records injected_at then (see the Desktop adapter).
        logger.info({ ...fields, delivery: 'tool_result', reason: 'buffered_until_wait' }, 'Questionnaire v2 answer buffered for the sync ask_user call');
        return 'tool_result';
    }
    const conversation = deps.conversation;
    if (!conversation) {
        throw new LocalQuestionnaireError(503, 'CONVERSATION_UNAVAILABLE', 'Runtime Conversation is unavailable for questionnaire reply');
    }
    // A retry or restart must not deliver twice: an answer already parked in
    // the queue is delivered (and marked) when the queue admits its Turn.
    if (await hasQueuedAnswer(conversation, record)) {
        logger.info({ ...fields, delivery: 'already_queued', reason: 'queue_item_exists' }, 'Questionnaire v2 answer delivery skipped');
        return 'already_queued';
    }
    const message = await v2AnswerMessage(deps, record, reply);
    try {
        const steered = await conversation.ingress.steer({
            sessionId: record.sessionId,
            source: 'questionnaire',
            message,
            producerId: QUESTIONNAIRE_ANSWER_STEERING_PRODUCER,
            idempotencyKey: record.requestId,
        });
        if (steered.mode === 'activated') {
            await markV2Injected(deps, record.requestId, 'steer_activated');
            logger.info({ ...fields, delivery: steered.mode, turnId: steered.turnId }, 'Questionnaire v2 answer delivered');
        }
        else {
            logger.info({
                ...fields,
                delivery: steered.mode,
                turnId: steered.turnId,
                reason: 'awaiting_steering_consumption',
            }, 'Questionnaire v2 answer joined the running Turn; injected_at waits for consumption');
        }
        return steered.mode;
    }
    catch (error) {
        if (!(error instanceof ConversationTurnRejectedError) ||
            TERMINAL_REJECTIONS.has(error.reason)) {
            throw error;
        }
        logger.info({ ...fields, delivery: 'queued', reason: error.reason }, 'Questionnaire v2 answer queued: session cannot start a Turn now');
    }
    return queueV2Answer(deps, conversation, record, message);
}
async function queueV2Answer(deps, conversation, record, message) {
    const fields = {
        requestId: record.requestId,
        sessionId: record.sessionId,
        responseMode: record.responseMode,
    };
    const identity = v2AnswerIdentity(record.requestId);
    try {
        const accepted = await conversation.ingress.submit({
            sessionId: record.sessionId,
            source: 'questionnaire',
            allowQueue: true,
            queuePlacement: 'front',
            clientRequestId: identity,
            dedupeKey: identity,
            message,
        });
        // Secondary signal for the rare case where the queue hands the item to a
        // running Turn instead of admitting a new one (no admission hook fires).
        void accepted.completion.then(async (result) => {
            if (result.status !== 'completed' && result.messages.length === 0) {
                logger.info({ ...fields, reason: 'queued_turn_not_started', status: result.status }, 'Questionnaire v2 queued answer was not delivered');
                return;
            }
            await markV2Injected(deps, record.requestId, 'queued_turn_settled');
        }, (error) => logger.warn({ ...fields, reason: 'queued_completion_failed', err: error }, 'Questionnaire v2 queued answer completion failed'));
        return 'queued';
    }
    catch (error) {
        if (error instanceof ConversationTurnRejectedError && error.reason === 'duplicate') {
            logger.info({ ...fields, delivery: 'already_queued', reason: 'duplicate' }, 'Questionnaire v2 answer delivery skipped');
            return 'already_queued';
        }
        throw error;
    }
}
/**
 * Checks both queue identities an answer can have: the front-of-queue
 * delivery (`questionnaire-reply:<id>`) and a steer the Turn system returned
 * to the queue after its Turn closed (batch identity, answer origin kept).
 */
async function hasQueuedAnswer(conversation, record) {
    const identity = v2AnswerIdentity(record.requestId);
    if (await conversation.ingress.findQueuedByClientRequestId(record.sessionId, identity)) {
        return true;
    }
    const queued = await conversation.ingress.listQueued(record.sessionId);
    return queued.some((item) => [item.message.origin, ...(item.batchOrigins ?? [])].some((origin) => isOrdinaryQuestionnaireResponseOrigin(origin) && origin.requestId === record.requestId));
}
/**
 * Writes `injected_at` once and publishes `questionnaire.state`. The CAS makes
 * concurrent signals (steer ACK + admission hook, admission + completion)
 * publish a single transition.
 */
export async function markV2Injected(deps, requestId, reason) {
    const marked = await deps.store.markInjectedOnce(requestId, deps.nowMs());
    const record = await deps.store.get(requestId);
    if (!marked || !record) {
        logger.info({ requestId, sessionId: record?.sessionId, reason: `${reason}:already_injected` }, 'Questionnaire v2 injected_at already set');
        return false;
    }
    publishQuestionnaireState(deps, record, reason);
    return true;
}
async function v2AnswerMessage(deps, record, reply) {
    const images = await recoverQuestionnaireImageAttachments(deps, record.sessionId, reply);
    return {
        content: [
            serializeQuestionnaireResponseMessage(record.request, reply, deps.resolveLocale?.()),
            ...images.notes,
        ].join('\n\n'),
        attachments: images.attachments,
        // The ordinary-response origin lets the queued item bypass the legacy
        // questionnaire queue gate and lets the admission hook find this row.
        origin: {
            kind: 'questionnaire-response',
            requestId: record.requestId,
            mode: 'questionnaire',
            purpose: 'ordinary',
        },
    };
}
//# sourceMappingURL=v2-answer-delivery.js.map