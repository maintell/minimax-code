import { findSessionAncestor, } from '../../session-system/index.js';
export { findSessionAncestor };
/**
 * The task a Session's work belongs to: the Session itself when it is assigned,
 * otherwise the nearest assigned Session above it. A subagent's approval request
 * is the task's to show and to wait on.
 */
export async function findOwningTaskSessionId(readers, sessionId) {
    // Only the parent chain is read, from the shared database; the task index answers the rest.
    const owner = await findSessionAncestor((id) => readers.sessions.get(id), sessionId, (session) => readers.tasks.assignerOf(session.sessionId) !== undefined);
    return owner?.sessionId;
}
//# sourceMappingURL=session-ancestry.js.map