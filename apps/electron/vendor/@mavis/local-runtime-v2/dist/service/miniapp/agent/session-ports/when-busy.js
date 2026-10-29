import { randomUUID } from 'node:crypto';
import { createUserMessageId, } from '../../../session-system/index.js';
import { detach, settleQuietly } from '../../../channel-system/settle.js';
import { MiniAppAgentError } from '../contracts.js';
import { modelSelectionFromQueue, modelSelectionFromRecord } from '../model-selection.js';
import { ABORTED, abortQuietly, beforeDispatch, confirmCancelled, deliverChecked, emit, errorFields, finish, followOwnedTurn, outcomeUnknown, preDeliveryCheck, read, readField, rejectedTurn, resumeAfterStaleTerminal, settleAbortedTurn, TIMED_OUT, timeoutPromise, } from './turn-follow.js';
import { watchRequeue } from './requeue-watch.js';
/** The Desktop composer steer producer semantics: never extends a finished answer, kept on stop. */
const MINIAPP_STEER_PRODUCER = 'miniapp-steer';
/** Rejections that mean "a turn is running or work is queued ahead": the text waits in the queue. */
const QUEUE_FALLBACK_REASONS = new Set([
    'active-turn',
    'compaction-active',
    'priority-blocked',
    'delivery-closed',
]);
/** How long a queued text that was settled without being seen in a turn may still show up. */
const LANDING_AFTER_SETTLE_TIMEOUT_MS = 15_000;
/**
 * `whenBusy` follows the Desktop composer: an idle session starts a turn; a busy one queues the
 * text or steers it into the running turn. The call then follows the turn its own text opened,
 * or ends `steered` once a running turn took the text in.
 */
export async function runWhenBusy(options, input, run) {
    const message = newMessageIdentity(input.sessionId);
    // Watched before the text is handed over: the running turn may put it back at any point after.
    const requeue = input.whenBusy === 'steer'
        ? watchRequeue(options, input.sessionId, message.userMessageId)
        : undefined;
    try {
        return await deliverMessage(options, input, {
            ...run,
            message,
            ...(requeue ? { requeue } : {}),
        });
    }
    finally {
        requeue?.dispose();
    }
}
async function deliverMessage(options, input, run) {
    const { message } = run;
    const placement = await placeMessage(options, input, message);
    if (placement.kind === 'turn') {
        input.onOwnTurn?.();
        return followOwnedTurn(options, input, { ...run, turnId: placement.turnId });
    }
    if (placement.kind === 'pending') {
        emit(input.onEvent, [
            { type: 'message.pending', sessionId: input.sessionId, turnId: placement.turnId },
        ]);
    }
    try {
        return await awaitLanding(options, input, { ...run, placement });
    }
    catch (error) {
        if (!(error instanceof MiniAppAgentError) && placement.kind === 'queued') {
            await cancelQueuedQuietly(options, input.sessionId, placement);
        }
        throw error;
    }
}
function newMessageIdentity(sessionId) {
    const requestId = randomUUID();
    return {
        requestId,
        userMessageId: createUserMessageId({ sessionId, messageKey: `miniapp:${requestId}` }),
    };
}
/**
 * An idle session behind a paused queue starts the turn only when nothing the user stopped is
 * still queued, resuming the queue (Desktop's automatic "keep"); otherwise the text waits.
 */
async function placeMessage(options, input, message) {
    const first = input.whenBusy === 'steer'
        ? await steerMessage(options, input, message)
        : await startMessage(options, input, message);
    if (first.kind !== 'busy')
        return first;
    if (first.reason === 'priority-blocked' &&
        (await isPausedWithoutQueuedItems(options, input.sessionId))) {
        const kept = await startMessage(options, input, message, { resumePausedQueue: true });
        if (kept.kind !== 'busy')
            return kept;
    }
    return enqueueMessage(options, input, message);
}
function messageProvenance(sessionId, message) {
    return {
        source: 'miniapp',
        routingFingerprint: `miniapp:${sessionId}:${message.requestId}`,
    };
}
async function startMessage(options, input, message, resume = {}) {
    const { sessionId } = input;
    const result = await deliverChecked(() => options.turns.submit({
        sessionId,
        allowQueue: false,
        input: { text: input.text },
        provenance: messageProvenance(sessionId, message),
        userMessageId: message.userMessageId,
        ...(resume.resumePausedQueue
            ? { resumePausedQueue: true, clientIntent: 'paused-queue-keep' }
            : {}),
        delivery: preDeliveryCheck(input.beforeDelivery),
    }));
    if (result.accepted) {
        ignoreCompletion(result.completion);
        return { kind: 'turn', turnId: result.turnId };
    }
    if (QUEUE_FALLBACK_REASONS.has(result.reason))
        return { kind: 'busy', reason: result.reason };
    throw rejectedTurn();
}
async function steerMessage(options, input, message) {
    const { sessionId } = input;
    const result = await deliverChecked(() => options.turns.steer({
        sessionId,
        input: { text: input.text },
        producerId: MINIAPP_STEER_PRODUCER,
        idempotencyKey: message.requestId,
        userMessageId: message.userMessageId,
        provenance: messageProvenance(sessionId, message),
        ...preDeliveryCheck(input.beforeDelivery),
    }));
    if (!result.delivered) {
        if (QUEUE_FALLBACK_REASONS.has(result.reason))
            return { kind: 'busy', reason: result.reason };
        throw rejectedTurn();
    }
    if (result.mode === 'activated') {
        ignoreCompletion(result.completion);
        return { kind: 'turn', turnId: result.turnId };
    }
    if (result.mode === 'steered')
        return { kind: 'pending', turnId: result.turnId };
    // A fresh idempotency key cannot match an earlier delivery.
    throw outcomeUnknown('Mini App Agent steer matched an earlier delivery');
}
async function enqueueMessage(options, input, message) {
    const { sessionId } = input;
    // A queued item runs later without a delivery hook; this is the last point the call can stop it.
    input.beforeDelivery?.();
    const result = await options.turns.submit({
        sessionId,
        allowQueue: true,
        input: { text: input.text },
        provenance: messageProvenance(sessionId, message),
        userMessageId: message.userMessageId,
    });
    if (!result.accepted)
        throw rejectedTurn();
    if (result.mode !== 'queued') {
        ignoreCompletion(result.completion);
        return { kind: 'turn', turnId: result.turnId };
    }
    emit(input.onEvent, [{ type: 'run.queued', sessionId, position: result.queue.position }]);
    const model = await frozenItemModel(options, sessionId, result.queue.itemId);
    return {
        kind: 'queued',
        itemId: result.queue.itemId,
        turnId: result.turnId,
        settled: result.completion,
        ...(model ? { model } : {}),
    };
}
/**
 * Queue admission freezes a listed managed model into the item, and the dispatcher runs the turn
 * on it whatever the session switches to meanwhile. Undefined when the item froze none (that turn
 * resolves the session's model when it runs) or when it was already taken.
 */
async function frozenItemModel(options, sessionId, itemId) {
    try {
        return modelSelectionFromQueue((await options.queue.get(sessionId, itemId))?.model);
    }
    catch (error) {
        options.logger.warn({ stage: 'queued-model', sessionId, itemId, ...errorFields(error) }, 'Mini App Agent could not read the model its queued message runs on');
        return undefined;
    }
}
async function isPausedWithoutQueuedItems(options, sessionId) {
    return beforeDispatch(options, { stage: 'queue-pause-lookup', sessionId }, async () => {
        const [snapshot, items] = await Promise.all([
            options.queue.snapshot(sessionId),
            options.queue.list(sessionId),
        ]);
        return snapshot.pause !== undefined && items.length === 0;
    });
}
/** The run follows its turn through the session stream; the completion only must not go unhandled. */
function ignoreCompletion(completion) {
    detach(settleQuietly(completion));
}
/**
 * Waits until the text shows up in a turn. A `steered_user` row means a running turn took it in
 * (read, or kept in the conversation when that turn stopped); any other row means it opened
 * its own turn, which the call then follows like `run`.
 */
async function awaitLanding(options, input, wait) {
    const { sessionId } = input;
    const landing = await nextLanding(options, sessionId, wait);
    if (landing === ABORTED)
        return cancelWaiting(options, input, wait);
    if (landing.steered) {
        emit(input.onEvent, [{ type: 'message.steered', sessionId, turnId: landing.turnId }]);
        return { turnId: landing.turnId, status: 'steered' };
    }
    input.onOwnTurn?.();
    const model = await ownTurnModel(options, input, wait);
    // Keep the call's own start as the question boundary: the turn may already have asked by now,
    // and a queued text only runs once questions of earlier turns were settled.
    return followOwnedTurn(options, { ...input, model }, { ...wait, turnId: landing.turnId });
}
/** Reads frames until the text's row shows up; the queued item's settlement ends the wait only on removal. */
async function nextLanding(options, sessionId, wait) {
    const queue = watchQueueSettlement(wait.placement);
    try {
        for (;;) {
            const next = await read(wait.source, queue.stopOr(wait.aborted));
            if (next === ABORTED)
                return ABORTED;
            if (next === TIMED_OUT) {
                throw outcomeUnknown('Mini App Agent queued message settled but was not seen in a turn');
            }
            if (next === QUEUE_SETTLED) {
                queue.afterSettled();
                continue;
            }
            if (next.done) {
                throw new Error('Session stream ended before the Mini App Agent message landed');
            }
            const landing = landingOf(next.value, wait.message.userMessageId);
            if (landing)
                return landing;
            if (endsPendingTurn(wait, next.value))
                wait.requeue?.resolve();
            await resumeAfterStaleTerminal(options, sessionId, wait.source, next.value);
        }
    }
    finally {
        queue.dispose();
    }
}
/** The turn a steer was handed to ended without reading it: the text is back in the queue now. */
function endsPendingTurn(wait, frame) {
    return (wait.placement.kind === 'pending' &&
        frame.kind === 'turn-terminal' &&
        frame.turnId === wait.placement.turnId);
}
const QUEUE_SETTLED = Symbol('queue-settled');
/** Watches a queued item's completion; a steer has nothing to watch. */
function watchQueueSettlement(placement) {
    let outcome;
    let settled = placement.kind === 'queued'
        ? recordSettlement(placement.settled, (value) => {
            outcome = value;
        })
        : undefined;
    let deadline;
    return {
        // Only promises that can still settle: each read races them again.
        stopOr: (aborted) => Promise.race([
            aborted,
            ...(settled ? [settled] : []),
            ...(deadline ? [deadline.promise] : []),
        ]),
        afterSettled() {
            settled = undefined;
            // `queue-cancelled` / `queue-composer-transferred` come only from a removal before activation.
            if (outcome?.status === 'aborted' && (outcome.reason ?? '').startsWith('queue-')) {
                throw new MiniAppAgentError('REQUEST_CANCELLED', 'Mini App Agent queued message was removed before it ran');
            }
            if (outcome?.status !== 'completed') {
                deadline = timeoutPromise(LANDING_AFTER_SETTLE_TIMEOUT_MS);
            }
        },
        dispose: () => deadline?.dispose(),
    };
}
async function recordSettlement(settled, record) {
    try {
        record(await settled);
    }
    catch (error) {
        record({ status: 'failed', error });
    }
    return QUEUE_SETTLED;
}
/** The row the text was committed as, from a live commit or a replayed durable message. */
function landingOf(frame, userMessageId) {
    if (!frame.turnId)
        return undefined;
    const row = committedRows(frame).find((candidate) => readField(candidate, 'msg_id') === userMessageId);
    if (row === undefined)
        return undefined;
    return { turnId: frame.turnId, steered: readField(row, 'kind') === STEERED_USER_KIND };
}
function committedRows(frame) {
    if (frame.kind === 'durable-message')
        return [frame.data];
    if (frame.kind !== 'message-committed')
        return [];
    const rows = readField(frame.data, 'messages');
    return Array.isArray(rows) ? rows : [];
}
/** Message kind of a user row a running turn took in (`UserMessageTurnDelivery.consumeSteering`). */
const STEERED_USER_KIND = 'steered_user';
/**
 * The model the text's own turn runs on: the one its queue item froze, whether the call queued it
 * or the runtime put a steer back. All calls following that turn report the same.
 */
async function ownTurnModel(options, input, wait) {
    if (wait.placement.kind === 'queued' && wait.placement.model)
        return wait.placement.model;
    const requeued = await wait.requeue?.item();
    return requeued?.model ?? landedModel(options, input.sessionId, input.model);
}
/** A turn without a frozen model runs on the session's model as it is when the turn starts. */
async function landedModel(options, sessionId, fallback) {
    try {
        const record = await options.repository.get(sessionId);
        return (record && modelSelectionFromRecord(record)) ?? fallback;
    }
    catch {
        return fallback;
    }
}
/**
 * A steer handed to a running turn cannot be withdrawn. A queued text is removed from the queue;
 * one already claimed has opened (or is opening) its own turn, which is stopped like `run`'s.
 */
async function cancelWaiting(options, input, wait) {
    const { sessionId } = input;
    const { placement } = wait;
    if (placement.kind === 'pending') {
        options.logger.warn({ stage: 'cancel-steer', sessionId, turnId: placement.turnId }, 'Mini App Agent cancelled a steer the running turn may still read');
        throw outcomeUnknown('Mini App Agent message was handed to the running turn and cannot be withdrawn');
    }
    if (await removeQueued(options, sessionId, placement.itemId)) {
        throw new MiniAppAgentError('REQUEST_CANCELLED', 'Mini App Agent run was cancelled');
    }
    const { turnId } = placement;
    const abort = await options.turns.abort({ sessionId, turnId, reason: 'miniapp-cancelled' });
    const terminal = await settleAbortedTurn(options, sessionId, wait.source, turnId);
    return finish(input, confirmCancelled(options, { sessionId, turnId, abort, terminal }));
}
/** True only when the item was still queued and is now gone; a claimed item is not editable. */
async function removeQueued(options, sessionId, itemId) {
    try {
        const removed = await options.queue.cancel(sessionId, itemId);
        return removed !== undefined && removed !== 'not_editable';
    }
    catch (error) {
        options.logger.warn({ stage: 'cancel-queued', sessionId, itemId, ...errorFields(error) }, 'Mini App Agent could not remove its queued message');
        return false;
    }
}
/**
 * The stream was lost while the text waited: do not leave it to run without a caller. An item
 * already claimed has opened its own turn, which is stopped instead.
 */
async function cancelQueuedQuietly(options, sessionId, placement) {
    if (await removeQueued(options, sessionId, placement.itemId))
        return;
    await abortQuietly(options, sessionId, placement.turnId);
}
//# sourceMappingURL=when-busy.js.map