import { formatUnknownError } from './host-support.js';
export async function beginLocalTurnFileChanges(turnFileChanges, reportPiTurnFailure, session, turnId) {
    try {
        await turnFileChanges.begin(session, turnId);
    }
    catch (err) {
        reportPiTurnFailure(session.sessionId, `local_turn_diff_begin_failed:${formatUnknownError(err)}`);
    }
}
export async function finalizeLocalTurnFileChanges(turnFileChanges, reportPiTurnFailure, sessionId, turnId, assistantMessageId) {
    try {
        await turnFileChanges.finalizeLatestPending(sessionId, { turnId, assistantMessageId });
    }
    catch (err) {
        reportPiTurnFailure(sessionId, `local_turn_diff_finalize_failed:${formatUnknownError(err)}`);
    }
}
export async function markLocalTurnFileChangesFailed(turnFileChanges, reportPiTurnFailure, sessionId, turnId) {
    try {
        await turnFileChanges.markPendingFailed(sessionId, turnId);
    }
    catch (err) {
        reportPiTurnFailure(sessionId, `local_turn_diff_failed:${formatUnknownError(err)}`);
    }
}
//# sourceMappingURL=host-turn-file-changes.js.map