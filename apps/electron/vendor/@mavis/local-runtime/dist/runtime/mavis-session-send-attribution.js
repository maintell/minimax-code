import { randomUUID } from 'node:crypto';
import { logger } from '../common/logger.js';
/** Upper bound on the parent chain walk; real task nesting is a few levels deep. */
const MAX_SESSION_ANCESTRY_DEPTH = 32;
/**
 * A send from a caller Turn into one of the caller's descendant Sessions may
 * start a new round there; that round belongs to the caller Turn (Goal token
 * accounting). The pairing is reported under a pre-generated Turn id before the
 * ingress call, so it precedes the round's first request. Sends to the caller
 * itself or to any non-descendant Session are not reported and keep the
 * runtime-chosen Turn id. Never throws.
 */
export async function attributeSessionSendRound(deps, req, target) {
    const callerTurnId = req.callerTurnId;
    if (!callerTurnId)
        return undefined;
    const port = deps.subSessionRoundAttribution?.();
    if (!port)
        return undefined;
    const requestedTurnId = `turn_session_send_${randomUUID()}`;
    try {
        if (!(await isDescendantSession(deps, target, req.callerSessionId)))
            return undefined;
        await port.attributeRound({
            parentSessionId: req.callerSessionId,
            parentTurnId: callerTurnId,
            childSessionId: req.sessionId,
            childTurnId: requestedTurnId,
        });
        return { port, requestedTurnId };
    }
    catch (error) {
        logger.warn({
            callerSessionId: req.callerSessionId,
            sessionId: req.sessionId,
            error: error instanceof Error ? error.message : String(error),
        }, 'Session send could not attribute its round to the caller Turn');
        try {
            port.forgetRound(requestedTurnId);
        }
        catch {
            // Attribution is advisory; it never changes the send.
        }
        return undefined;
    }
}
async function isDescendantSession(deps, target, ancestorSessionId) {
    const visited = new Set([target.sessionId]);
    let parentSessionId = target.parentSessionId ?? undefined;
    for (let depth = 0; parentSessionId && depth < MAX_SESSION_ANCESTRY_DEPTH; depth += 1) {
        if (parentSessionId === ancestorSessionId)
            return true;
        if (visited.has(parentSessionId))
            return false;
        visited.add(parentSessionId);
        const parent = await deps.conversation.query.getSession(parentSessionId);
        parentSessionId = parent?.parentSessionId ?? undefined;
    }
    return false;
}
//# sourceMappingURL=mavis-session-send-attribution.js.map