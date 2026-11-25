import { randomUUID } from 'node:crypto';
import { callbackify } from 'node:util';
import { ConversationTurnRejectedError, isRuntimeConversationShutdownError, isRuntimeConversationUnavailableError, } from '@mavis/conversation-contract';
import { queuesPeerDelivery } from '@mavis/shared/agent-coordination';
import { dispatchAttachments } from '../../../infra/conversation/dispatch-attachments.js';
import { logger } from '../../../infra/logging/logger.js';
import { peerSessionSendOrigin, resolveSessionSendOrigin } from './mavis-session-send-origin.js';
import { reclaimAdmittedSessionSend } from './mavis-session-send-completion.js';
import { attributeSessionSendRound } from './mavis-session-send-attribution.js';
import { mapSessionSendRejection, sessionSendError, SessionSendRuntimeError, throwIfSessionSendAborted, } from './mavis-session-send-errors.js';
/**
 * SessionSend admits one message into any reachable, unarchived local Session.
 * Reachability is the whole access model: the caller identity comes from the
 * runtime context, the target must be resolvable through the canonical Session
 * query, and everything after that is TurnSystem admission. There is no
 * topology check — a task child, a sibling, a root Session and the caller's own
 * Session all take the same path.
 *
 * Every local send is a steer. An idle target starts a Turn with the message;
 * a busy one reads it before its next step instead of after the Turn it is
 * running; one that can take it neither way (its Turn is closing, it is
 * compacting, its Queue is paused) queues it. Two sends queue instead of
 * steering: one to a main conversation whose Agent declares `peerDelivery:
 * queue`, and one that asked for the next Turn (`forceQueue`). Sessions answer
 * each other the same way: the receiver sends its
 * answer back to `from_session_id` (the peer envelope says so), so a local send
 * never blocks on the target's Turn and `sync` only applies to remote targets.
 */
export async function sendToLocalSession(deps, req, signal) {
    // Logged once per call so every later line — admission, rejection — can be
    // correlated back to the caller that asked for it. The caller id never comes
    // from the model, so this pair is also the audit record of who reached which
    // Session.
    logger.info({ callerSessionId: req.callerSessionId, sessionId: req.sessionId }, 'Session send requested');
    try {
        throwIfSessionSendAborted(signal, req.sessionId, 'aborted-before-target-query');
        const target = await validateSessionSendTarget(deps, req.sessionId);
        throwIfSessionSendAborted(signal, req.sessionId, 'aborted-before-admission');
        const { message, sideChatOrigin } = await buildSessionSendMessage(deps, req);
        // The origin reads are DB round trips, so the caller can cancel between the
        // last check and the ingress call. Nothing has been delivered yet, which
        // makes this the last point where an abort costs nothing to honour.
        throwIfSessionSendAborted(signal, req.sessionId, 'aborted-after-origin-resolution');
        const route = resolveSessionSendRoute(deps, req, target);
        const admission = await admitSessionSend(deps, req, { target, message, route });
        req.onAdmitted?.();
        logger.info({
            callerSessionId: req.callerSessionId,
            sessionId: req.sessionId,
            turnId: admission.turnId,
            mode: admission.mode,
            route,
            ...originLogFields(req, sideChatOrigin),
        }, 'Session send was admitted');
        // The caller can give up while the ingress call is in flight. The message
        // is already admitted at this point, so the abort has to be honoured by
        // reclaiming that work rather than by returning an ACK for something the
        // caller no longer wants.
        if (signal?.aborted)
            throw abortAdmittedSessionSend(deps, req, admission);
        return acknowledgeSessionSend(req, admission, target);
    }
    catch (error) {
        // Already-shaped rejections were logged where they were built; the two
        // remaining classes are translated here, and anything else is re-thrown
        // with a log so an unmapped failure never leaves the adapter unexplained.
        if (error instanceof SessionSendRuntimeError)
            throw error;
        if (error instanceof ConversationTurnRejectedError) {
            throw await mapSessionSendRejection(error, deps.turnOwnedByOtherRuntime);
        }
        if (isRuntimeConversationUnavailableError(error) || isRuntimeConversationShutdownError(error)) {
            throw sessionSendError('Runtime Conversation is unavailable for session send', {
                status: 503,
                code: 'SESSION_SEND_UNAVAILABLE',
                sessionId: req.sessionId,
                reason: 'conversation-unavailable',
            });
        }
        logger.warn({
            callerSessionId: req.callerSessionId,
            sessionId: req.sessionId,
            error: error instanceof Error ? error.message : String(error),
        }, 'Session send failed with an unmapped error');
        throw error;
    }
}
/**
 * The message as the target stores it. An assignment origin is frozen by its
 * sender and wins over both readers; otherwise a SideChat hand-back keeps its
 * SideChat origin and everything else carries the peer origin.
 */
async function buildSessionSendMessage(deps, req) {
    const sideChatOrigin = req.assignmentOrigin === undefined ? await resolveSessionSendOrigin(deps, req) : undefined;
    const origin = req.assignmentOrigin ?? sideChatOrigin ?? (await peerSessionSendOrigin(deps, req));
    return {
        message: { content: req.content, attachments: dispatchAttachments(req.attachments), origin },
        sideChatOrigin,
    };
}
async function validateSessionSendTarget(deps, sessionId) {
    const target = await deps.conversation.query.getSession(sessionId);
    if (!target) {
        throw sessionSendError(`Session not found: ${sessionId}`, {
            status: 404,
            code: 'SESSION_NOT_FOUND',
            sessionId,
            reason: 'target-unresolvable',
        });
    }
    if (target.archived) {
        throw sessionSendError(`Session is archived: ${sessionId}`, {
            status: 409,
            code: 'SESSION_ARCHIVED',
            sessionId,
            reason: 'target-archived',
        });
    }
    return target;
}
/**
 * Reclaims an admission the caller no longer wants and builds the error that
 * replaces its ACK. The completion is still observed, because the reclaim only
 * requests cancellation — the promise itself must never be left unconsumed.
 */
function abortAdmittedSessionSend(deps, req, admission) {
    logger.info({
        callerSessionId: req.callerSessionId,
        sessionId: req.sessionId,
        turnId: admission.turnId,
        mode: admission.mode,
        reason: 'aborted-after-admission',
    }, 'Session send is reclaiming work that was admitted after the caller aborted');
    observeAbandonedSessionSendTurn(req, admission);
    reclaimAdmittedSessionSend(deps.conversation, req, admission);
    return sessionSendError('Session send was aborted after Turn admission', {
        status: 409,
        code: 'SESSION_TURN_ABORTED',
        sessionId: req.sessionId,
        turnId: admission.turnId,
        reason: 'aborted-after-admission',
    });
}
/**
 * Steers the message into the target and records which caller Turn started a
 * new round there.
 *
 * The steer identity is deliberate: `producerId` mirrors the local
 * communication path (`communication:<fromSession>`) so the caller Session
 * stays visible in steering logs and in the durable message key, while the
 * `session-send:` prefix keeps this producer out of
 * `isUserSteeringProducer()`. Staying a machine producer is the point — a user
 * producer would be deferred at the Turn exit boundary, which is composer
 * behaviour, not delegation behaviour. The same prefix makes teardown keep the
 * message (`isTeardownDurableSteeringProducer()`), because the sender has already
 * been told it arrived. The rendered message therefore matches what task_append
 * already produces in a target Session. `idempotencyKey` is new per call because
 * two SessionSend calls are two distinct messages; there is no replay to
 * collapse. `raceFallback` keeps a message the target cannot take yet: unlike
 * task_append it is not bound to one Turn, so any later Turn may run it.
 */
async function admitSessionSend(deps, req, { target, message, route, }) {
    const attribution = await attributeSessionSendRound(deps, req, target);
    const requestedTurnId = attribution?.requestedTurnId;
    let admission;
    try {
        admission =
            route === 'queue'
                ? await queueSessionSend(deps, req, message, requestedTurnId)
                : await deps.conversation.ingress.steer({
                    sessionId: req.sessionId,
                    source: 'communication',
                    producerId: `session-send:${req.callerSessionId}`,
                    idempotencyKey: `session-send:${randomUUID()}`,
                    message,
                    raceFallback: 'queue',
                    ...(requestedTurnId ? { requestedTurnId } : {}),
                });
    }
    catch (error) {
        attribution?.port.forgetRound(attribution.requestedTurnId);
        throw error;
    }
    // Only a new round of its own carries the requested id; a message merged into
    // a running round leaves that round's attribution to whoever started it.
    if (attribution &&
        (admission.mode !== 'activated' || admission.turnId !== attribution.requestedTurnId)) {
        attribution.port.forgetRound(attribution.requestedTurnId);
    }
    return admission;
}
/**
 * Queues the message behind whatever the target is running; an idle target
 * starts its Turn at once. Answered in the steer vocabulary: a dispatched item
 * is `activated`, one still waiting is `queued`.
 */
async function queueSessionSend(deps, req, message, requestedTurnId) {
    const accepted = await deps.conversation.ingress.submit({
        sessionId: req.sessionId,
        source: 'communication',
        allowQueue: true,
        message,
        ...(requestedTurnId ? { requestedTurnId } : {}),
    });
    // Queue admission answers `queued` even when it already started this item's
    // own Turn on an idle target; `ahead: 0` alone can still be cap-blocked.
    const started = accepted.mode === 'started' ||
        (accepted.mode === 'queued' && accepted.queue?.dispatched === true);
    if (started) {
        return { turnId: accepted.turnId, mode: 'activated', completion: accepted.completion };
    }
    return {
        turnId: accepted.turnId,
        mode: 'queued',
        completion: accepted.completion,
        ...(accepted.queue
            ? {
                queue: {
                    itemId: accepted.queue.itemId,
                    position: accepted.queue.position,
                    ahead: accepted.queue.ahead,
                },
            }
            : {}),
    };
}
/**
 * The main conversation of an Agent that declares `peerDelivery: queue` never
 * takes a peer message into its running Turn: the message queues behind it and
 * starts a Turn of its own (for Bunny, spec 4.3: woken as `peer`). `forceQueue`
 * asks for the same on any target. Everything else is steered.
 */
function resolveSessionSendRoute(deps, req, target) {
    if (req.forceQueue === true)
        return 'queue';
    const queuesPeer = target.sessionType === 'root' &&
        target.sideChat === undefined &&
        queuesPeerDelivery(deps.coordinationOf?.(target.agentName));
    return queuesPeer ? 'queue' : 'steer';
}
/** The SideChat origin by its kind; an assignment origin is opaque here, so only its presence. */
function originLogFields(req, sideChatOrigin) {
    if (req.assignmentOrigin !== undefined)
        return { assignmentOrigin: true };
    return sideChatOrigin ? { origin: sideChatOrigin.kind } : {};
}
/**
 * The only answer a local send gives. It reports what the target Session did
 * with the message rather than what the Agent replied, so the model never
 * mistakes an admission for an answer.
 */
function acknowledgeSessionSend(req, admission, target) {
    observeAbandonedSessionSendTurn(req, admission);
    return {
        sessionId: req.sessionId,
        turnId: admission.turnId,
        status: 'accepted',
        mode: admission.mode,
        ...(target.parentSessionId === req.callerSessionId
            ? {
                subagent_executions: [
                    {
                        agent_name: target.agentName,
                        sub_session_id: target.sessionId,
                        sub_turn_id: admission.turnId,
                        parent_session_id: req.callerSessionId,
                        status: admission.mode === 'activated' ? 'started' : admission.mode,
                    },
                ],
            }
            : {}),
        ...(admission.queue ? { queue: admission.queue } : {}),
        note: describeSessionSendAdmission(admission.mode),
    };
}
/**
 * Shared tail of every acknowledgement note. In the 2026-11 cross-session eval
 * (M3.1-Flash and M78) callers kept polling the target with `session messages`
 * or `sleep` until the note said outright that ending the Turn loses nothing.
 * It must never suggest re-sending: a second call is a second message, so the
 * target would run the same work — and its side effects — twice.
 */
const SESSION_SEND_REPLY_NOTE = ' If the target answers, the answer arrives here as a new message and starts a new turn, so ending your turn now loses nothing. Do not poll for it, wait with sleep, or send this message again.';
function describeSessionSendAdmission(mode) {
    if (mode === 'duplicate') {
        return `This message was already merged into the Turn running in the target Session.${SESSION_SEND_REPLY_NOTE}`;
    }
    if (mode === 'steered') {
        return `This message was merged into the Turn already running in the target Session.${SESSION_SEND_REPLY_NOTE}`;
    }
    if (mode === 'queued') {
        return `The target Session cannot take this message yet, so it is queued and runs there once the Session is free.${SESSION_SEND_REPLY_NOTE}`;
    }
    return `A new Turn started in the target Session.${SESSION_SEND_REPLY_NOTE}`;
}
/**
 * The ACK hands Turn ownership to the target Session, so nothing awaits the
 * completion anymore. It still has to be consumed: an unconsumed rejected
 * completion would surface as an unhandled rejection in the runtime process,
 * and the settlement is the only trace left of work this caller started.
 */
function observeAbandonedSessionSendTurn(req, admission) {
    callbackify(logAbandonedSessionSendTurn)(req, admission, (error) => {
        if (error) {
            logger.warn({ sessionId: req.sessionId, turnId: admission.turnId, error }, 'Session send completion observer failed');
        }
    });
}
async function logAbandonedSessionSendTurn(req, admission) {
    if (!admission.completion)
        return;
    const identity = {
        callerSessionId: req.callerSessionId,
        sessionId: req.sessionId,
        turnId: admission.turnId,
        mode: admission.mode,
    };
    try {
        const result = await admission.completion;
        logger.info({ ...identity, status: result.status }, 'Session send Turn settled after its ACK');
    }
    catch (error) {
        logger.warn({ ...identity, error: error instanceof Error ? error.message : String(error) }, 'Session send Turn failed after its ACK');
    }
}
//# sourceMappingURL=mavis-session-send.js.map