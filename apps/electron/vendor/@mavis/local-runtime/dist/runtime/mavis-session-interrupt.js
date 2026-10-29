import { logger } from '../common/logger.js';
import { sessionSendError } from './mavis-session-send-errors.js';
/**
 * The abort source `session interrupt` uses. Only the Turn stops: the Runtime
 * cascades into background work and pauses the Goal and Queue for `user_stop`
 * and `session_leave` alone, so queued messages still run afterwards.
 */
export const AGENT_INTERRUPT_REASON = 'agent_interrupt';
/**
 * Stops another Session's current Turn on behalf of an Agent. Self-interrupt is
 * rejected by the tool layer before this point; the caller id is logged so the
 * audit trail shows who stopped which Session.
 */
export async function interruptLocalSession(deps, req) {
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
    const result = await deps.conversation.ingress.interruptTurn({
        sessionId: req.sessionId,
        reason: AGENT_INTERRUPT_REASON,
        ...(req.turnId ? { turnId: req.turnId } : {}),
    });
    logger.info({
        callerSessionId: req.callerSessionId,
        sessionId: req.sessionId,
        requestedTurnId: req.turnId,
        status: result.status,
    }, 'Session interrupt resolved');
    return toInterruptResponse(req, result);
}
function toInterruptResponse(req, result) {
    switch (result.status) {
        case 'aborted':
            return { outcome: 'aborted', turnId: result.turnId };
        case 'not-running':
            return { outcome: 'not_running' };
        case 'turn-mismatch':
            // The contract does not say which turn is running, so the requested id is
            // echoed under its own name. Putting it in turnId would look like the
            // current turn.
            throw Object.assign(sessionSendError(`Turn ${req.turnId ?? ''} is no longer the turn running in ${req.sessionId}. Check the current turn with session get.`.trim(), {
                status: 409,
                code: 'SESSION_INTERRUPT_TURN_MISMATCH',
                sessionId: req.sessionId,
            }), req.turnId ? { requestedTurnId: req.turnId } : {});
        case 'abort-timeout':
            throw sessionSendError('The stop was signalled but the turn is still closing. Check it with session get; do not repeat the interrupt automatically.', {
                status: 409,
                code: 'SESSION_INTERRUPT_TIMEOUT',
                sessionId: req.sessionId,
                turnId: result.turnId,
            });
    }
}
//# sourceMappingURL=mavis-session-interrupt.js.map