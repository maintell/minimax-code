import { callbackify } from 'node:util';
import { logger } from '../../../infra/logging/logger.js';
/**
 * A caller that aborts after admission only reclaims work it actually owns.
 * Every branch logs, including the one that deliberately does nothing, because
 * "the message stayed in the target Session" is exactly the outcome an
 * operator needs to see.
 */
export function reclaimAdmittedSessionSend(conversation, req, admission) {
    const identity = {
        sessionId: req.sessionId,
        turnId: admission.turnId,
        mode: admission.mode,
        reason: 'caller-abort',
    };
    if (admission.mode !== 'activated') {
        // Aborting here would cancel another producer's Turn, and the content is
        // already part of it or waits in the target's Queue, so it stays there.
        logger.info(identity, 'Session send will not reclaim a message it did not start a Turn for');
        return;
    }
    logger.info(identity, 'Session send is aborting the Turn it admitted');
    callbackify(abortAdmittedTurn)(conversation, req, admission, identity, (error) => {
        if (error)
            logger.warn({ ...identity, error }, 'Session send reclaim observer failed');
    });
}
/**
 * Targeted abort of the Turn this call admitted. Passing the admitted turn id
 * is what makes the reclaim safe: `TurnController.abort` answers
 * `turn-mismatch` without touching the Session when a different Turn is
 * running. Best-effort, but logged rather than swallowed, because a Turn that
 * refuses to abort is the interesting case.
 */
async function abortAdmittedTurn(conversation, req, admission, identity) {
    try {
        const aborted = await conversation.ingress.abort(req.sessionId, 'lifecycle', admission.turnId);
        if (aborted)
            return;
        logger.warn(identity, 'Session send could not abort the Turn it admitted; another Turn owns the Session now');
    }
    catch (error) {
        logger.warn({ ...identity, error: error instanceof Error ? error.message : String(error) }, 'Session send could not abort the Turn it admitted');
    }
}
//# sourceMappingURL=mavis-session-send-completion.js.map