import { isGoalVerifierTaskPurpose } from '@mavis/shared/goal-verifier-purpose';
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
 * The delegated shape alone — a hidden branch Session of kind `task` with a
 * parent and the canonical `verifier` agent name — is not enough: the main
 * agent routes every ordinary review to the same `verifier` agent, so a user's
 * "have a subagent review this" child has that shape too. What only the Goal
 * run leaves on the row is its purpose: the delegation persists the tool call
 * id (see `api/local-task-runner.ts`), and the Goal run passes a
 * `goal-verifier:` one. Children an earlier build created without that id are
 * treated as ordinary, which keeps pause and clear available on them.
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
    if (session.sessionKind !== 'task')
        return false;
    return isGoalVerifierTaskPurpose(session.purpose);
}
//# sourceMappingURL=verifier-session.js.map