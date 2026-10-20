import { logger } from '../common/logger.js';
import { isLocalChildWorkerSession } from '../sessions/session-policy.js';
/** Resolves the Session scope without rejecting and preserves the existing diagnostics. */
export async function resolveUserStopScope(host, sessionId) {
    try {
        const session = await host.getSessionById(sessionId);
        if (!session) {
            log('user_stop_cascade_session_missing', { sessionId });
            return 'missing';
        }
        if (isLocalChildWorkerSession(session)) {
            log('cascade_skipped_child_session', { sessionId });
            return 'child';
        }
        return 'root';
    }
    catch (error) {
        log('user_stop_cascade_begin_failed', { sessionId, error: errorMessage(error) });
        return 'failed';
    }
}
function log(event, fields) {
    try {
        logger.info({ event: `background_task_${event}`, ...fields }, `User stop cascade: ${event}`);
    }
    catch {
        // Diagnostics must not interfere with an in-progress stop.
    }
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=user-stop-scope.js.map