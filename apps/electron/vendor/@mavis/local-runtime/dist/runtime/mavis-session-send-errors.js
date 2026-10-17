import { logger } from '../common/logger.js';
export class SessionSendRuntimeError extends Error {
    status;
    code;
    sessionId;
    turnId;
    constructor(message, details) {
        super(message);
        this.name = 'SessionSendRuntimeError';
        this.status = details.status;
        this.code = details.code;
        this.sessionId = details.sessionId;
        if (details.turnId)
            this.turnId = details.turnId;
    }
}
/**
 * The single construction point for every SessionSend rejection, so the log and
 * the model-visible error can never drift apart. `code` is what an operator
 * greps for; `reason` names the branch that produced it, which matters most for
 * `SESSION_BUSY` (five distinct admission reasons) and `SESSION_TURN_ABORTED`
 * (aborted before the target query, before admission, or as a Turn terminal).
 */
export function sessionSendError(message, details) {
    logger.warn({
        code: details.code,
        status: details.status,
        sessionId: details.sessionId,
        ...(details.turnId ? { turnId: details.turnId } : {}),
        ...(details.reason ? { reason: details.reason } : {}),
    }, `Session send rejected: ${message}`);
    return new SessionSendRuntimeError(message, details);
}
export function throwIfSessionSendAborted(signal, sessionId, reason) {
    if (!signal?.aborted)
        return;
    throw sessionSendError('Session send was aborted before Turn admission', {
        status: 409,
        code: 'SESSION_TURN_ABORTED',
        sessionId,
        reason,
    });
}
/**
 * Admission rejections carry the TurnSystem's own reason, which is strictly
 * more informative than the collapsed `SESSION_BUSY` the model sees. It is kept
 * in the log so a busy report can still be traced to compaction, deletion or a
 * priority fence — including the self-send case, where the reason is the
 * caller's own `active-turn`.
 */
export function mapTurnRejection(error) {
    if (error.reason === 'invalid-session') {
        return sessionSendError(`Session not found: ${error.sessionId}`, {
            status: 404,
            code: 'SESSION_NOT_FOUND',
            sessionId: error.sessionId,
            reason: error.reason,
        });
    }
    if (error.reason === 'active-turn' ||
        error.reason === 'compaction-active' ||
        error.reason === 'session-deleting' ||
        error.reason === 'priority-blocked' ||
        error.reason === 'ingress-conflict') {
        return sessionSendError(`Session is busy: ${error.sessionId} (${error.reason})`, {
            status: 409,
            code: 'SESSION_BUSY',
            sessionId: error.sessionId,
            reason: error.reason,
        });
    }
    return sessionSendError(`Session Turn admission was rejected: ${error.sessionId} (${error.reason})`, {
        status: 409,
        code: 'SESSION_SEND_REJECTED',
        sessionId: error.sessionId,
        reason: error.reason,
    });
}
//# sourceMappingURL=mavis-session-send-errors.js.map