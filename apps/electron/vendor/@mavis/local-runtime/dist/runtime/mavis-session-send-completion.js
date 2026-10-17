import { isRuntimeConversationShutdownError, isRuntimeConversationUnavailableError, } from '@mavis/conversation-contract';
import { logger } from '../common/logger.js';
import { sessionSendError } from './mavis-session-send-errors.js';
/** The synchronous answer: wait for the admitted Turn and return its text. */
export async function awaitSessionSendTerminal(conversation, req, admission, signal) {
    const releaseAbortListener = attachSessionSendAbort(conversation, req, admission, signal);
    try {
        let result;
        try {
            result = await admission.completion;
        }
        catch (error) {
            if (isRuntimeConversationUnavailableError(error) ||
                isRuntimeConversationShutdownError(error)) {
                throw error;
            }
            throw sessionSendError(error instanceof Error ? error.message : 'Session Turn completion failed', {
                status: 500,
                code: 'SESSION_TURN_FAILED',
                sessionId: req.sessionId,
                turnId: admission.turnId,
                reason: 'completion-rejected',
            });
        }
        if (result.status === 'aborted') {
            throw sessionSendError(result.error ?? 'Session Turn was aborted', {
                status: 409,
                code: 'SESSION_TURN_ABORTED',
                sessionId: req.sessionId,
                turnId: admission.turnId,
                reason: 'terminal-aborted',
            });
        }
        if (result.status === 'failed') {
            throw sessionSendError(result.error ?? 'Session Turn failed', {
                status: 500,
                code: 'SESSION_TURN_FAILED',
                sessionId: req.sessionId,
                turnId: admission.turnId,
                reason: 'terminal-failed',
            });
        }
        const content = result.messages
            .map((message) => (message.role === 'assistant' ? message.text : undefined))
            .filter((text) => typeof text === 'string')
            .join('\n');
        logger.info({
            callerSessionId: req.callerSessionId,
            sessionId: req.sessionId,
            turnId: admission.turnId,
            mode: admission.mode,
            contentLength: content.length,
        }, 'Session send completed');
        return {
            sessionId: req.sessionId,
            turnId: admission.turnId,
            status: 'completed',
            content,
        };
    }
    finally {
        releaseAbortListener();
    }
}
function attachSessionSendAbort(conversation, req, admission, signal) {
    if (!signal)
        return () => undefined;
    let reclaimRequested = false;
    const onAbort = () => {
        if (reclaimRequested)
            return;
        reclaimRequested = true;
        reclaimAdmittedSessionSend(conversation, req, admission);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted)
        onAbort();
    return () => signal.removeEventListener('abort', onAbort);
}
/**
 * A caller that stops waiting only reclaims work it actually owns, and the
 * reclaim differs per admission mode. Every branch logs, including the one that
 * deliberately does nothing, because "the message stayed in the target Session"
 * is exactly the outcome an operator needs to see.
 */
export function reclaimAdmittedSessionSend(conversation, req, admission) {
    const identity = {
        sessionId: req.sessionId,
        turnId: admission.turnId,
        mode: admission.mode,
        reason: 'caller-abort',
    };
    if (admission.mode === 'steered' || admission.mode === 'duplicate') {
        // Aborting here would cancel another producer's Turn, and the content is
        // already part of it, so there is nothing to take back.
        logger.info(identity, 'Session send will not reclaim a message merged into a Turn it does not own');
        return;
    }
    if (admission.mode === 'queued' && admission.queue) {
        // The message is still a Queue row, so the reclaim starts as a cancel, not
        // an abort: an untargeted `abort` would stop whichever Turn currently holds
        // the Session, which is not the work this call admitted.
        const queueIdentity = { ...identity, queueItemId: admission.queue.itemId };
        logger.info(queueIdentity, 'Session send is cancelling the Queue item it admitted');
        void conversation.ingress.cancelQueued(req.sessionId, admission.queue.itemId).then((cancelled) => {
            if (cancelled && cancelled !== 'not_editable')
                return;
            // `not_editable` (claimed) and `undefined` (already gone) both mean the
            // item left the Queue between admission and this reclaim, so the work
            // this call admitted is now a running Turn. Leaving it there would
            // strand both the Turn and the completion nobody is waiting for.
            logger.info({ ...queueIdentity, outcome: cancelled ?? 'not-found' }, 'Session send Queue item is no longer cancellable; aborting the Turn it became');
            abortAdmittedTurn(conversation, req, admission, queueIdentity);
        }, (error) => {
            logger.warn({ ...queueIdentity, error: error instanceof Error ? error.message : String(error) }, 'Session send failed to cancel the Queue item it admitted');
        });
        return;
    }
    logger.info(identity, 'Session send is aborting the Turn it admitted');
    abortAdmittedTurn(conversation, req, admission, identity);
}
/**
 * Targeted abort of the Turn this call admitted. Passing the admitted turn id
 * is what makes the reclaim safe: `TurnController.abort` answers
 * `turn-mismatch` without touching the Session when a different Turn is
 * running, and the TurnSystem facade maps a queued admission id to its
 * execution id first, so a Queue item that just started running is still
 * reachable by the id this call holds.
 *
 * Best-effort: for a synchronous send the completion is the authoritative
 * outcome, so a failed abort must not replace it. It is still logged rather
 * than swallowed, because a Turn that refuses to abort is the interesting case.
 */
function abortAdmittedTurn(conversation, req, admission, identity) {
    void conversation.ingress.abort(req.sessionId, 'lifecycle', admission.turnId).then((aborted) => {
        if (aborted)
            return;
        logger.warn(identity, 'Session send could not abort the Turn it admitted; another Turn owns the Session now');
    }, (error) => {
        logger.warn({ ...identity, error: error instanceof Error ? error.message : String(error) }, 'Session send could not abort the Turn it admitted');
    });
}
//# sourceMappingURL=mavis-session-send-completion.js.map