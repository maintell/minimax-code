import { normalizeAbortSource } from '@mavis/agent-core/pi-turn-runner';
/**
 * Abort sources after which the Session queue must not drain on its own. An
 * explicit stop and leaving the conversation (TUI `/clear` or switching Sessions,
 * both of which still stop the live Turn) each mean the user stopped attending to
 * this Session, so its pending instructions wait for them instead of
 * auto-dispatching. The two differ only in whether background work is cascaded.
 * Both pause with the `user-stop` cause, the only user-driven cause the queue
 * schema accepts.
 *
 * Turn settlement and the steering fallback requeue both decide through this one
 * predicate, so the two pause decisions cannot drift apart again.
 */
export function pausesQueueOnAbort(reason) {
    const source = normalizeAbortSource(reason);
    return source === 'user_stop' || source === 'session_leave';
}
/** The abort reason a Goal pause or clear stops its own running Goal Turn with. */
export const THREAD_GOAL_PAUSED_ABORT_REASON = 'thread-goal-paused';
/**
 * Abort reasons after which the Session queue drains as it does after a
 * completed Turn. A Goal pause or clear stops only the Goal's own Turn: the user is
 * still in the conversation, so ordinary messages queued behind that Turn run
 * as normal conversation (spec §10) instead of waiting for an unrelated wake.
 * Other non-pausing aborts keep their caller-owned follow-up.
 */
export function wakesQueueOnAbort(reason) {
    // agent_interrupt stops only the running Turn (D11), so the messages already
    // queued behind it run. It stays out of pausesQueueOnAbort, which is reserved
    // for the user stepping away.
    return (reason === THREAD_GOAL_PAUSED_ABORT_REASON || normalizeAbortSource(reason) === 'agent_interrupt');
}
//# sourceMappingURL=queue-pause-on-abort.js.map