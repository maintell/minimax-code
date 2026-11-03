/**
 * IM follow-up routing under the desktop follow-up preference
 * (`composer-send-behavior`: `queue` | `steer`).
 *
 * Today's path — `submit({ allowQueue: true })` — stays the answer for every
 * case but one: "immediate send" while the Session runs a Turn started from
 * the same IM chat. Only that Turn's terminal reply lands back on this chat,
 * so only then is the message merged into it. Every other busy case queues
 * and reports why; every failure (preference read, probe, race) falls back to
 * today's queue path.
 *
 * The busy/idle and Turn-source checks are side-effect free and run before
 * any steer: a steer into an idle Session would activate a Turn instead (and
 * already admit a session Query), which is the submit path's job.
 */
import { createHash, randomUUID } from 'node:crypto';
import { ConversationTurnRejectedError } from '@mavis/conversation-contract';
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
import { CHANNEL_STEER_PRODUCER_ID, describeFollowError, } from './channel-follow-contracts.js';
import { checkReplayBeforeSteer, findMergedEventTurn } from './channel-follow-replay.js';
/** Today's IM enqueue: submit with queueing allowed, projected to the queue receipt. */
export async function submitChannelMessage(ingress, submit) {
    const accepted = await ingress.submit(submit);
    return accepted.queue
        ? {
            itemId: accepted.queue.itemId,
            position: accepted.queue.position,
            ahead: accepted.queue.ahead,
        }
        : undefined;
}
/**
 * Routes one ordinary IM message by the follow-up preference. Logs exactly one
 * routing decision line per message (no message content).
 */
export async function routeChannelFollowMessage(deps, input) {
    const decision = newFollowDecision(input);
    try {
        const plan = await planFollowRoute(deps, input, decision);
        decision.route = plan.route;
        if (plan.route === 'duplicate')
            return duplicateReceipt(plan, decision);
        if (plan.route === 'steer') {
            const steered = await steerIntoActiveTurn(deps, input, plan.turnId, decision);
            if (steered !== 'fallback')
                return steered;
            // Race: the Turn ended or moved between the check and the steer. This is
            // the plain idle/queue case now, so it gets today's path and notice.
            decision.route = 'submit';
        }
        const queued = await submitChannelMessage(deps.ingress, input.submit);
        decision.queued = Boolean(queued);
        if (queued) {
            decision.ahead = queued.ahead;
            decision.position = queued.position;
        }
        const queueReason = plan.route === 'submit' ? plan.queueReason : undefined;
        return queued && queueReason ? withQueueReason(queued, queueReason, decision) : queued;
    }
    catch (error) {
        decision.error = describeFollowError(error);
        throw error;
    }
    finally {
        logger.info({ ...decision }, 'IM follow-up routing decision');
    }
}
/** The routing decision line for one IM message: the request id only as a hash. */
function newFollowDecision(input) {
    return {
        sessionId: input.submit.sessionId,
        platform: input.source.slice('channel:'.length),
        ...(input.submit.clientRequestId
            ? { requestKey: hashChannelRequestId(input.submit.clientRequestId) }
            : {}),
    };
}
/** Already admitted: deliver nothing again and stay silent toward IM. */
function duplicateReceipt(plan, decision) {
    if (plan.turnId)
        decision.duplicateTurnId = plan.turnId;
    return { steered: 'duplicate', ...(plan.turnId ? { turnId: plan.turnId } : {}) };
}
/**
 * `ahead` counts the running Turn plus the queued messages in front, so 0
 * means the busy Turn ended meanwhile and the dispatcher took this message at
 * once. "Queued until the current task ends" would then be false, so the
 * reason is dropped and the plain path stays silent, as it does for `ahead` 0.
 */
function withQueueReason(queued, queueReason, decision) {
    if (queued.ahead <= 0) {
        decision.queueReasonDropped = 'nothing_ahead';
        return queued;
    }
    decision.queueReason = queueReason;
    return { ...queued, queueReason };
}
async function planFollowRoute(deps, input, decision) {
    const mergedTurnId = await findMergedEventTurn(deps, input.submit.clientRequestId, decision);
    if (mergedTurnId) {
        decision.reason = 'replay_merged';
        return { route: 'duplicate', turnId: mergedTurnId };
    }
    decision.preference = await readFollowPreference(deps, decision);
    if (decision.preference !== 'steer') {
        decision.reason = preferenceReason(decision.preference);
        return { route: 'submit' };
    }
    const probe = await probeActiveTurn(deps, input.submit.clientRequestId, decision);
    if (probe.kind !== 'ok') {
        // Without a trustworthy Turn source the safe answer is today's queue path;
        // a reason notice would be a guess, so none is sent.
        decision.reason = probe.kind === 'unavailable' ? 'probe_unavailable' : 'probe_failed';
        return { route: 'submit' };
    }
    const active = probe.snapshot;
    if (!active) {
        // Idle Session: submit starts the Turn right away, exactly like today.
        decision.reason = 'session_idle';
        return { route: 'submit' };
    }
    decision.activeTurnId = active.turnId;
    const plan = planBusyRoute(input, active, decision);
    return plan.route === 'steer'
        ? checkReplayBeforeSteer(deps, input, { active, plan }, decision)
        : plan;
}
function planBusyRoute(input, active, decision) {
    const incoming = input.submit.message.channelContext;
    if (!incoming) {
        // Ordinary IM messages always carry their chat; without it there is no
        // chat to compare, so keep today's behaviour instead of guessing.
        decision.reason = 'missing_channel_context';
        return { route: 'submit' };
    }
    if (!active.channelContext) {
        decision.reason = 'non_im_turn';
        return { route: 'submit', queueReason: 'non_im_turn' };
    }
    if (!isSameImChat(incoming, active.channelContext)) {
        decision.reason = 'other_im_chat';
        return { route: 'submit', queueReason: 'other_im_chat' };
    }
    decision.reason = 'same_im_chat';
    return { route: 'steer', turnId: active.turnId };
}
function preferenceReason(preference) {
    if (preference === 'queue')
        return 'preference_queue';
    return preference === 'unavailable' ? 'preference_unavailable' : 'preference_read_failed';
}
/**
 * Fail-soft like Session send: losing the preference must not fail an IM
 * message, and `queue` is both the product default and the safer fallback.
 */
async function readFollowPreference(deps, decision) {
    if (!deps.composerSendBehavior)
        return 'unavailable';
    try {
        return (await deps.composerSendBehavior()) === 'steer' ? 'steer' : 'queue';
    }
    catch (error) {
        logger.warn({
            sessionId: decision.sessionId,
            platform: decision.platform,
            error: describeFollowError(error),
        }, 'IM follow-up could not read the composer send behavior preference; falling back to queue');
        return 'read_failed';
    }
}
async function probeActiveTurn(deps, clientRequestId, decision) {
    if (!deps.activeTurnChannelProbe) {
        // The V2 runtime binds the probe after its Turn and Channel owners exist;
        // a host without them cannot tell which chat a running Turn belongs to.
        logger.warn({ sessionId: decision.sessionId, platform: decision.platform }, 'IM follow-up active Turn probe is not bound; falling back to queue');
        return { kind: 'unavailable' };
    }
    try {
        return {
            kind: 'ok',
            snapshot: await deps.activeTurnChannelProbe(decision.sessionId, clientRequestId),
        };
    }
    catch (error) {
        logger.warn({
            sessionId: decision.sessionId,
            platform: decision.platform,
            error: describeFollowError(error),
        }, 'IM follow-up active Turn probe failed; falling back to queue');
        return { kind: 'failed' };
    }
}
/**
 * Rejection raised from `preDelivery` when the steer would not land in the
 * exact Turn that was checked: either no Turn was running any more (the steer
 * would activate one) or another Turn took its place.
 */
class ChannelFollowTurnMovedError extends Error {
    mode;
    turnId;
    constructor(mode, turnId) {
        super(`IM follow-up steer no longer targets the checked Turn (${mode} ${turnId})`);
        this.mode = mode;
        this.turnId = turnId;
        this.name = 'ChannelFollowTurnMovedError';
    }
}
async function steerIntoActiveTurn(deps, input, expectedTurnId, decision) {
    try {
        const steered = await deps.ingress.steer({
            sessionId: input.submit.sessionId,
            source: input.source,
            producerId: CHANNEL_STEER_PRODUCER_ID,
            // The IM event id keeps a replayed event from being merged twice; the
            // durable receipt makes the replay come back as `duplicate`.
            idempotencyKey: input.submit.clientRequestId ?? `channel-steer:${randomUUID()}`,
            message: input.submit.message,
            preDelivery: {
                accept: async ({ mode, turnId }) => {
                    if (mode !== 'steered' || turnId !== expectedTurnId) {
                        throw new ChannelFollowTurnMovedError(mode, turnId);
                    }
                },
            },
        });
        decision.steerMode = steered.mode;
        decision.steerTurnId = steered.turnId;
        if (steered.mode !== 'activated') {
            return {
                steered: steered.mode === 'steered' ? 'merged' : 'duplicate',
                turnId: steered.turnId,
            };
        }
        // preDelivery rejects every activation, so this is unreachable today. If
        // it ever happens the message started an IM-sourced Turn of its own —
        // the same outcome as an idle submit — so no notice is owed.
        decision.steerFallback = 'unexpected_activation';
        return undefined;
    }
    catch (error) {
        if (error instanceof ChannelFollowTurnMovedError) {
            decision.steerFallback = 'turn_moved';
            return 'fallback';
        }
        if (error instanceof ConversationTurnRejectedError) {
            // e.g. the Turn is already closing (`delivery-closed`): nothing reached
            // it, so the queue path is still safe and keeps today's behaviour.
            decision.steerFallback = 'steer_rejected';
            decision.steerRejectReason = error.reason;
            return 'fallback';
        }
        throw error;
    }
}
function isSameImChat(left, right) {
    return (left.platform === right.platform &&
        left.clientName === right.clientName &&
        left.chatId === right.chatId &&
        normalizedThreadId(left.threadId) === normalizedThreadId(right.threadId));
}
/** Reply routing drops blank thread ids, so blank and absent are the same thread. */
function normalizedThreadId(threadId) {
    return threadId?.trim() ? threadId : undefined;
}
/**
 * Same hash the v2 channel ingress logs as `requestKey`: the raw request id
 * embeds transport identifiers and stays out of logs.
 */
function hashChannelRequestId(requestId) {
    return createHash('sha256').update(requestId, 'utf8').digest('hex');
}
//# sourceMappingURL=channel-follow-send.js.map