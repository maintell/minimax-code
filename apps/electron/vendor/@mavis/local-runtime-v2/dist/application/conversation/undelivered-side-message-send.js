import { toUserModelSelection } from './model-selection.js';
import { mapV2TurnStreamResult, staticFrames, undeliveredSideMessageError, } from './session-stream-delivery.js';
/**
 * `SendMessageReq.retry_message_id` / `discard_message_id` on the normal send
 * route (no new DesktopService method). Both only act on an undelivered row of
 * the request's Session and ignore any content or attachments in the request.
 *
 * - Discard runs before any activation, send or enqueue: 200 SSE with one
 *   `{"type":"message_discarded","message_discarded":{session_id,message_id,
 *   goal_resumed,already_discarded?}}` frame, then `[DONE]`. Repeating it is a
 *   no-op with `already_discarded: true`.
 * - Retry re-sends the stored content and attachments as a fresh composer side
 *   message and answers exactly like one: the steered or activated Turn stream,
 *   or the `queue_fallback` / `steer_duplicate` frame. Failing again answers 409
 *   `local_side_message_undelivered` for the same row, which stays undelivered.
 *
 * Errors: 400 `local_side_message_action_conflict` (both ids), 404
 * `local_side_message_not_found`, 409 `local_side_message_not_undelivered`,
 * 409 `local_side_message_action_in_progress`.
 *
 * Returns undefined when the request is an ordinary send.
 */
export async function openUndeliveredSideMessageAction(req, messages, directSend) {
    const retryId = nonEmpty(req.retryMessageId);
    const discardId = nonEmpty(req.discardMessageId);
    if (!retryId && !discardId)
        return undefined;
    if (retryId && discardId) {
        return error(400, 'local_side_message_action_conflict', 'Retry and discard are exclusive.');
    }
    if (!messages) {
        return error(409, 'local_side_message_not_undelivered', 'Message is not undelivered.');
    }
    return discardId
        ? discardSideMessage(req.id, discardId, messages)
        : retrySideMessage(req, retryId, messages, directSend);
}
async function discardSideMessage(sessionId, messageId, messages) {
    const result = await messages.discard(sessionId, messageId);
    if (result.status === 'in-progress')
        return inProgress();
    if (result.status === 'not-undelivered')
        return notUndelivered();
    return frames([
        {
            type: 'message_discarded',
            message_discarded: {
                session_id: sessionId,
                message_id: messageId,
                goal_resumed: result.status === 'discarded' && result.goalResumed,
                ...(result.status === 'already-discarded' ? { already_discarded: true } : {}),
            },
        },
    ]);
}
async function retrySideMessage(req, messageId, messages, directSend) {
    const result = await messages.retry(req.id, messageId, async (stored) => {
        const sent = await directSend.open(retrySend(stored, req.model));
        return { delivery: retryDelivery(sent), value: sent };
    });
    switch (result.status) {
        case 'delivered':
            return mapV2TurnStreamResult(result.value);
        case 'failed':
            // The same row stays undelivered; a race answers like the first failure.
            return !result.value.accepted && result.value.reason === 'side-message-undelivered'
                ? streamError(undeliveredSideMessageError({
                    race: result.value.race,
                    undelivered: { messageId },
                }))
                : mapV2TurnStreamResult(result.value);
        case 'already-delivered':
            // A repeated retry of a row an earlier retry already delivered.
            return mapV2TurnStreamResult({
                accepted: true,
                outcome: 'duplicate',
                sessionId: req.id,
                turnId: result.turnId,
            });
        case 'missing':
            return error(404, 'local_side_message_not_found', 'Undelivered message not found.');
        case 'in-progress':
            return inProgress();
        default:
            return notUndelivered();
    }
}
/** The stored message as a fresh composer side message; a new model choice wins. */
function retrySend(stored, model) {
    const selected = model ? toUserModelSelection(model) : stored.model;
    return {
        sessionId: stored.sessionId,
        input: {
            text: stored.text,
            ...(stored.attachments.length > 0 ? { attachments: stored.attachments } : {}),
            ...(selected ? { model: selected } : {}),
            ...(stored.computerUse ? { computerUse: { enable: stored.computerUse.enable } } : {}),
        },
        provenance: stored.provenance,
        ...(stored.displayContent !== undefined ? { displayContent: stored.displayContent } : {}),
        ...(stored.displayAttachments ? { displayAttachments: stored.displayAttachments } : {}),
        requestedTurnId: stored.retryKey,
        clientIntent: 'composer-steer',
        recordUndelivered: false,
    };
}
function retryDelivery(result) {
    if (!result.accepted)
        return { kind: 'failed' };
    if ('outcome' in result) {
        return result.outcome === 'queued'
            ? {
                kind: 'delivered',
                mode: 'queued',
                turnId: result.turnId,
                queueItemId: result.queue.itemId,
            }
            : { kind: 'delivered', mode: 'duplicate', turnId: result.turnId };
    }
    return {
        kind: 'delivered',
        mode: result.completion ? 'activated' : 'steered',
        turnId: result.turnId,
    };
}
function frames(events) {
    return {
        ok: true,
        source: staticFrames([
            ...events.map((event) => ({ dataJson: JSON.stringify(event) })),
            { dataJson: '[DONE]' },
        ]),
    };
}
function inProgress() {
    return error(409, 'local_side_message_action_in_progress', 'Another retry or discard of this message is still running.');
}
function notUndelivered() {
    return error(409, 'local_side_message_not_undelivered', 'Message is not undelivered.');
}
function error(status, key, message) {
    return streamError({ status, key, message });
}
function streamError(input) {
    return {
        ok: false,
        status: input.status,
        body: {
            sseErrorCode: 0,
            code: input.status,
            key: input.key,
            message: input.message,
            ...(input.detail ? { detail: input.detail } : {}),
        },
    };
}
function nonEmpty(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
//# sourceMappingURL=undelivered-side-message-send.js.map