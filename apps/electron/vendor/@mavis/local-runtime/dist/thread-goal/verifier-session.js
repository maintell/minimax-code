/**
 * Canonical role of the built-in Goal verification subagent. The verifier child
 * is spawned through the ordinary delegation path, so this name is the only
 * thing the persisted Session row carries about its role.
 */
const GOAL_VERIFIER_AGENT_NAME = 'verifier';
/**
 * A Goal verifier child Session must never own an ordinary Goal.
 *
 * The child runs with the `Verifier` system role: it may not mutate files and
 * has no `edit`, `write`, or `update_goal` tool. A Goal bound to it can never
 * make progress, so it loops between "ready" rechecks and verifier FAIL until
 * the no-progress breaker pauses it.
 *
 * The verifier identity is not stamped on the Session row — only the child's
 * Turn carries the `goalVerifier` origin. What the row does carry is the exact
 * delegated shape the verifier run creates (see `api/local-task-runner.ts`):
 * a hidden branch Session of kind `task` with a parent and the canonical
 * `verifier` agent name. All four facts together are the narrowest proof
 * available from persisted metadata, and they deliberately do not match a
 * parent conversation, a `worker` / `explore` child, or an ordinary chat.
 */
export function isGoalVerifierChildSession(session) {
    if (!session)
        return false;
    if (session.agentName !== GOAL_VERIFIER_AGENT_NAME)
        return false;
    if (!session.parentSessionId)
        return false;
    if (session.sessionType !== 'branch')
        return false;
    return session.sessionKind === 'task';
}
//# sourceMappingURL=verifier-session.js.map