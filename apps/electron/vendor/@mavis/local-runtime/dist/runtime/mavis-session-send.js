import { randomUUID } from 'node:crypto';
import { ConversationTurnRejectedError, isRuntimeConversationShutdownError, isRuntimeConversationUnavailableError, } from '@mavis/conversation-contract';
import { logger } from '../common/logger.js';
import { peerSessionSendOrigin, resolveSessionSendOrigin } from './mavis-session-send-origin.js';
import { awaitSessionSendTerminal, reclaimAdmittedSessionSend, } from './mavis-session-send-completion.js';
import { attributeSessionSendRound } from './mavis-session-send-attribution.js';
import { mapTurnRejection, sessionSendError, SessionSendRuntimeError, throwIfSessionSendAborted, } from './mavis-session-send-errors.js';
/**
 * SessionSend admits one message into any reachable, unarchived local Session.
 * Reachability is the whole access model: the caller identity comes from the
 * runtime context, the target must be resolvable through the canonical Session
 * query, and everything after that is TurnSystem admission. There is no
 * topology check — a task child, a sibling, a root Session and the caller's own
 * Session all take the same path.
 *
 * Two switches shape the call:
 * - `forceSteer` (default off) picks the `steer` entry point instead of the
 *   desktop `composer-send-behavior` preference.
 * - `sync` (default off) waits for the admitted Turn's terminal state and
 *   returns its assistant text. Asynchronous is the default, so a busy target
 *   no longer fails: queue routing enqueues and steer routing merges.
 *
 * `sync` is honoured only when this call owns a Turn it can safely outlive the
 * wait for; {@link resolveSessionSendSyncDowngrade} names the three cases where
 * it cannot.
 */
export async function sendToLocalSession(deps, req, signal) {
    const sync = req.sync === true;
    const forceSteer = req.forceSteer === true;
    // Logged once per call so every later line — routing, admission, rejection,
    // terminal — can be correlated back to the caller that asked for it. The
    // caller id never comes from the model, so this pair is also the audit record
    // of who reached which Session.
    logger.info({ callerSessionId: req.callerSessionId, sessionId: req.sessionId, sync, forceSteer }, 'Session send requested');
    try {
        throwIfSessionSendAborted(signal, req.sessionId, 'aborted-before-target-query');
        const target = await deps.conversation.query.getSession(req.sessionId);
        if (!target) {
            throw sessionSendError(`Session not found: ${req.sessionId}`, {
                status: 404,
                code: 'SESSION_NOT_FOUND',
                sessionId: req.sessionId,
                reason: 'target-unresolvable',
            });
        }
        if (target.archived) {
            throw sessionSendError(`Session is archived: ${req.sessionId}`, {
                status: 409,
                code: 'SESSION_ARCHIVED',
                sessionId: req.sessionId,
                reason: 'target-archived',
            });
        }
        throwIfSessionSendAborted(signal, req.sessionId, 'aborted-before-admission');
        // An abort during this read is caught by the post-route check in admission.
        const origin = await resolveSessionSendOrigin(deps, req);
        const admission = await admitSessionSend(deps, req, target, forceSteer, origin, signal);
        logger.info({
            callerSessionId: req.callerSessionId,
            sessionId: req.sessionId,
            turnId: admission.turnId,
            route: admission.route,
            mode: admission.mode,
            sync,
            ...(admission.queue
                ? { queueItemId: admission.queue.itemId, queuePosition: admission.queue.position }
                : {}),
        }, 'Session send was admitted');
        // The caller can give up while the ingress call is in flight. The message
        // is already admitted at this point, so the abort has to be honoured by
        // reclaiming that work rather than by returning an ACK for something the
        // caller no longer wants.
        if (signal?.aborted)
            throw abortAdmittedSessionSend(deps, req, admission);
        const decision = sync
            ? resolveSessionSendSyncDowngrade(req, admission, deps.sessionSendWaitGraph)
            : {};
        const completion = admission.completion;
        if (!sync || decision.downgrade || !completion) {
            if (decision.downgrade) {
                logger.info({
                    callerSessionId: req.callerSessionId,
                    sessionId: req.sessionId,
                    turnId: admission.turnId,
                    mode: admission.mode,
                    reason: decision.downgrade,
                    ...(decision.cyclePath ? { cyclePath: decision.cyclePath.join(' -> ') } : {}),
                }, 'Session send downgraded sync to an ACK');
            }
            return acknowledgeSessionSend(req, admission, decision.downgrade);
        }
        // The edge exists only while this call is actually blocked on the target,
        // and the release runs on every exit — terminal, abort or throw — because a
        // stranded edge would make every later send to this pair look like a cycle.
        const releaseWaitEdge = deps.sessionSendWaitGraph.register(req.callerSessionId, req.sessionId);
        try {
            return await awaitSessionSendTerminal(deps.conversation, req, { ...admission, completion }, signal);
        }
        finally {
            releaseWaitEdge();
        }
    }
    catch (error) {
        // Already-shaped rejections were logged where they were built; the two
        // remaining classes are translated here, and anything else is re-thrown
        // with a log so an unmapped failure never leaves the adapter unexplained.
        if (error instanceof SessionSendRuntimeError)
            throw error;
        if (error instanceof ConversationTurnRejectedError) {
            throw mapTurnRejection(error);
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
 * Names the cases where `sync: true` cannot be honoured. All three are
 * structural, not failures, so they answer with the admission ACK instead of an
 * error:
 *
 * - `joined-turn`: a merged steer owns no completion of its own, because the
 *   host Turn answers once for everything merged into it. This mirrors
 *   task_append, which also acknowledges a steer without a result.
 * - `self-send-sync-downgrade`: the target is the caller. The Turn making this
 *   call cannot finish until the tool returns, and the admitted work cannot
 *   start (queue) or finish (steer) until that Turn ends, so waiting here would
 *   deadlock the Session against itself. Asynchronous self-send is unaffected —
 *   queueing a message behind the current Turn is exactly what it should do.
 * - `sync-wait-cycle`: the same deadlock with more hops. The target (or
 *   something it is transitively waiting on) is already blocked on this
 *   caller's Session, so this wait would close the ring. The graph covers both
 *   synchronous sends and foreground task waits, so a child answering its
 *   blocked owner is caught here too. Self-send is the zero-hop case of exactly
 *   this, kept separate only because its note reads better.
 *
 * The old implementation was accidentally safe against all of these because it
 * never queued: a send into a busy Session was rejected as `SESSION_BUSY`
 * before any wait could start.
 *
 * Downgrading does not drop the message: it is already admitted, so the caller
 * returns, its Turn ends, and the ring unwinds on its own — the queued item
 * then runs and the other side's wait resolves normally.
 */
function resolveSessionSendSyncDowngrade(req, admission, waitGraph) {
    if (!admission.completion)
        return { downgrade: 'joined-turn' };
    if (req.sessionId === req.callerSessionId)
        return { downgrade: 'self-send-sync-downgrade' };
    const cyclePath = waitGraph.findCycle(req.callerSessionId, req.sessionId);
    return cyclePath ? { downgrade: 'sync-wait-cycle', cyclePath } : {};
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
 * Runs the selected ingress entry point and flattens both result shapes into
 * {@link SessionSendAdmission}.
 *
 * The steer identity is deliberate: `producerId` mirrors the local
 * communication path (`communication:<fromSession>`) so the caller Session
 * stays visible in steering logs and in the durable message key, while the
 * `session-send:` prefix keeps this producer out of
 * `isUserSteeringProducer()`. Staying a machine producer is the point — a user
 * producer would be deferred at the Turn exit boundary and requeued as a fresh
 * user query on teardown, which is composer behaviour, not delegation
 * behaviour. The rendered message therefore matches what task_append already
 * produces in a target Session. `idempotencyKey` is new per call because two
 * SessionSend calls are two distinct messages; there is no replay to collapse.
 */
async function admitSessionSend(deps, req, target, forceSteer, origin, signal) {
    const decision = await resolveSessionSendRoute(deps, req, forceSteer);
    const message = {
        content: req.content,
        attachments: [],
        origin: origin ?? (await peerSessionSendOrigin(deps, req)),
    };
    logger.info({
        callerSessionId: req.callerSessionId,
        sessionId: req.sessionId,
        forceSteer,
        route: decision.route,
        routeSource: decision.source,
        ...(decision.preference ? { composerSendBehavior: decision.preference } : {}),
        ...(origin ? { origin: origin.kind } : {}),
    }, 'Session send resolved its ingress route');
    // The preference read is a DB round trip, so the caller can cancel between
    // the last check and the ingress call. Nothing has been delivered yet, which
    // makes this the last point where an abort costs nothing to honour.
    throwIfSessionSendAborted(signal, req.sessionId, 'aborted-after-route-resolution');
    const attribution = await attributeSessionSendRound(deps, req, target);
    let admission;
    try {
        admission = await deliverSessionSend(deps, req, decision, message, attribution?.requestedTurnId);
    }
    catch (error) {
        attribution?.port.forgetRound(attribution.requestedTurnId);
        throw error;
    }
    // Only a new round of its own carries the requested id; a message merged into
    // a running round leaves that round's attribution to whoever started it.
    if (attribution &&
        (admission.mode === 'steered' ||
            admission.mode === 'duplicate' ||
            admission.turnId !== attribution.requestedTurnId)) {
        attribution.port.forgetRound(attribution.requestedTurnId);
    }
    return admission;
}
async function deliverSessionSend(deps, req, decision, message, requestedTurnId) {
    if (decision.route === 'steer') {
        const steered = await deps.conversation.ingress.steer({
            sessionId: req.sessionId,
            source: 'communication',
            producerId: `session-send:${req.callerSessionId}`,
            idempotencyKey: `session-send:${randomUUID()}`,
            message,
            ...(requestedTurnId ? { requestedTurnId } : {}),
        });
        return steered.mode === 'activated'
            ? {
                route: 'steer',
                turnId: steered.turnId,
                mode: 'activated',
                completion: steered.completion,
            }
            : { route: 'steer', turnId: steered.turnId, mode: steered.mode };
    }
    // `allowQueue: true` is the behavioural change against the old SessionSend:
    // a busy target now enqueues instead of being rejected as `SESSION_BUSY`.
    const accepted = await deps.conversation.ingress.submit({
        sessionId: req.sessionId,
        source: 'communication',
        allowQueue: true,
        message,
        ...(requestedTurnId ? { requestedTurnId } : {}),
    });
    // Queue admission answers `queued` even when it already started this item's
    // own Turn on an idle target; `ahead: 0` alone can still be cap-blocked.
    const started = accepted.mode === 'queued' && accepted.queue?.dispatched === true;
    return {
        route: 'submit',
        turnId: accepted.turnId,
        mode: started ? 'started' : accepted.mode,
        completion: accepted.completion,
        ...(accepted.queue && !started ? { queue: accepted.queue } : {}),
    };
}
/**
 * `force_steer` wins outright; otherwise the desktop preference decides. The
 * preference read is fail-soft on purpose: losing it must not fail a send, and
 * `queue` is both the product default and the safer fallback, because queueing
 * never merges content into a Turn the user is watching.
 */
async function resolveSessionSendRoute(deps, req, forceSteer) {
    if (forceSteer)
        return { route: 'steer', source: 'force-steer' };
    if (!deps.getComposerSendBehavior)
        return { route: 'submit', source: 'default-no-port' };
    try {
        const preference = await deps.getComposerSendBehavior();
        return {
            route: preference === 'steer' ? 'steer' : 'submit',
            source: 'preference',
            preference,
        };
    }
    catch (error) {
        logger.warn({
            callerSessionId: req.callerSessionId,
            sessionId: req.sessionId,
            error: error instanceof Error ? error.message : String(error),
        }, 'Session send could not read the composer send behavior preference; falling back to queue');
        return { route: 'submit', source: 'default-read-failed' };
    }
}
/**
 * The asynchronous answer. It reports what the target Session did with the
 * message rather than what the Agent replied, so the model never mistakes an
 * admission for an answer.
 */
function acknowledgeSessionSend(req, admission, downgrade) {
    observeAbandonedSessionSendTurn(req, admission);
    return {
        sessionId: req.sessionId,
        turnId: admission.turnId,
        status: 'accepted',
        mode: admission.mode,
        ...(admission.queue ? { queue: admission.queue } : {}),
        note: describeSessionSendAdmission(admission.mode, downgrade),
    };
}
/**
 * Shared tail of the acknowledgement notes for a Turn this call owns.
 *
 * It must never suggest re-sending to obtain the reply: a second call is a
 * second message, not a wait on the turn id in this ACK. Submit would enqueue
 * another item or open another Turn, and steer mints a fresh idempotency key,
 * so the target would run the same work — and its side effects — twice. `sync`
 * is therefore framed as a choice to make on the first send of a *future*
 * request, not as a remedy for this already-accepted one.
 */
const SESSION_SEND_FOLLOW_UP_NOTE = ' This call did not wait for it; read the reply with "session messages" once it has run. Do not send this message again to wait for it: a resend is a second message and would run the work twice. When a later request needs the reply inline, pass sync: true on that first send.';
function describeSessionSendAdmission(mode, downgrade) {
    // Why sync was not honoured, when it was asked for. The model needs the
    // reason to pick its next move: read the Session later, or stop waiting
    // because the answer is already coming back to it.
    const syncNote = downgrade === 'joined-turn'
        ? ' sync was not honoured because a merged message owns no completion.'
        : downgrade === 'self-send-sync-downgrade'
            ? ' sync was not honoured because this Session is the caller: its reply lands in this same conversation, and waiting for it here would deadlock the Turn making this call.'
            : downgrade === 'sync-wait-cycle'
                ? ' sync was not honoured because the target Session is already waiting on this one: both Turns would block on each other forever. Returning now lets this Turn finish, which unblocks the ring on its own.'
                : '';
    if (mode === 'steered' || mode === 'duplicate') {
        const merged = mode === 'duplicate'
            ? 'This message was already merged into the Turn running in the target Session.'
            : 'This message was merged into the Turn already running in the target Session.';
        // No sync advice here: a merged message can never be waited on, on this
        // call or any later one.
        return `${merged} That Turn answers once for everything merged into it, so this message gets no separate reply.${syncNote} Read the outcome with "session messages"; sending it again would merge a second copy into that Turn.`;
    }
    if (mode === 'queued') {
        return `The target Session was busy, so this message was queued and runs after the current Turn.${syncNote}${SESSION_SEND_FOLLOW_UP_NOTE}`;
    }
    return `A new Turn started in the target Session.${syncNote}${SESSION_SEND_FOLLOW_UP_NOTE}`;
}
/**
 * An asynchronous ACK hands Turn ownership to the target Session, so nothing
 * awaits the completion anymore. It still has to be consumed: an unconsumed
 * rejected completion would surface as an unhandled rejection in the runtime
 * process, and the settlement is the only trace left of work this caller
 * started and stopped watching.
 */
function observeAbandonedSessionSendTurn(req, admission) {
    if (!admission.completion)
        return;
    const identity = {
        callerSessionId: req.callerSessionId,
        sessionId: req.sessionId,
        turnId: admission.turnId,
        mode: admission.mode,
    };
    void admission.completion.then((result) => {
        logger.info({ ...identity, status: result.status }, 'Session send Turn settled after an asynchronous ACK');
    }, (error) => {
        logger.warn({ ...identity, error: error instanceof Error ? error.message : String(error) }, 'Session send Turn failed after an asynchronous ACK');
    });
}
//# sourceMappingURL=mavis-session-send.js.map