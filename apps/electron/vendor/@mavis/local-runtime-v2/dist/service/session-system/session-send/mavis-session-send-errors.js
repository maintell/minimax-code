import { logger } from '../../../infra/logging/logger.js';
export class SessionSendRuntimeError extends Error {
    status;
    code;
    sessionId;
    turnId;
    /** The admission reason behind a mapped rejection, when one exists. */
    admissionReason;
    constructor(message, details) {
        super(message);
        this.name = 'SessionSendRuntimeError';
        this.status = details.status;
        this.code = details.code;
        this.sessionId = details.sessionId;
        if (details.turnId)
            this.turnId = details.turnId;
        if (details.reason)
            this.admissionReason = details.reason;
    }
}
/**
 * The single construction point for every SessionSend rejection, so the log and
 * the model-visible error can never drift apart. `code` is what an operator
 * greps for; `reason` names the branch that produced it, which matters most for
 * `SESSION_BUSY` (five admission reasons and `other-runtime`) and `SESSION_TURN_ABORTED`
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
/** The busy reason a caller sees when the target's Turn runs in another runtime. */
const SESSION_RUNNING_IN_OTHER_RUNTIME = '会话正在另一个运行时里运行';
/**
 * {@link mapTurnRejection}, except that a busy target whose running Turn
 * another live runtime owns says so: this runtime cannot join that Turn at
 * all, so the caller has to wait for it to end rather than retry at once. A
 * probe that fails keeps the plain busy reason.
 */
export async function mapSessionSendRejection(error, turnOwnedByOtherRuntime) {
    if ((error.reason === 'active-turn' || error.reason === 'compaction-active') &&
        (await isOwnedElsewhere(turnOwnedByOtherRuntime, error.sessionId))) {
        return sessionSendError(`${SESSION_RUNNING_IN_OTHER_RUNTIME}：${error.sessionId}。这里插不进它正在跑的这一轮，等这一轮结束后再发。`, {
            status: 409,
            code: 'SESSION_BUSY',
            sessionId: error.sessionId,
            reason: 'other-runtime',
        });
    }
    return mapTurnRejection(error);
}
async function isOwnedElsewhere(probe, sessionId) {
    try {
        return (await probe?.(sessionId)) === true;
    }
    catch {
        return false;
    }
}
/**
 * Admission rejections carry the TurnSystem's own reason, which is strictly
 * more informative than the collapsed `SESSION_BUSY` the model sees. It is kept
 * in the log so a busy report can still be traced to compaction, deletion or a
 * priority fence — including the self-send case, where the reason is the
 * caller's own `active-turn`.
 */
export function mapTurnRejection(error) {
    // A send that would start a Turn in a task child while its parent is at the
    // child-Agent cap. Same code and advice as task_append and task
    // (background-bash SUBAGENT_CONCURRENCY_LIMIT), so the model waits and resends.
    if (error.reason === 'policy:subagent:concurrency-limit') {
        return sessionSendError('This parent Session has reached its configured child-Agent concurrency limit. Wait for one to finish, then retry.', {
            status: 409,
            code: 'SUBAGENT_CONCURRENCY_LIMIT',
            sessionId: error.sessionId,
            reason: error.reason,
        });
    }
    if (error.reason === 'policy:worktree:cleaned') {
        return sessionSendError(`The worktree of Session ${error.sessionId} was cleaned up automatically. The user must restore it in MiniMax Code Desktop; do not retry.`, {
            status: 409,
            code: 'SESSION_WORKTREE_CLEANED',
            sessionId: error.sessionId,
            reason: error.reason,
        });
    }
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