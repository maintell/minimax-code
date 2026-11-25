import { isGoalVerifierTaskPurpose } from '@mavis/shared/goal-verifier-purpose';
const LOCAL_DIRECT_TASK_PURPOSE_PREFIXES = ['local-task:', 'local-background-task:'];
export function isLocalDirectTaskPurpose(purpose) {
    return LOCAL_DIRECT_TASK_PURPOSE_PREFIXES.some((prefix) => purpose?.startsWith(prefix));
}
/** @internal Exported only for focused tests. */
export function isLocalTaskWorkerPurpose(purpose) {
    return isLocalDirectTaskPurpose(purpose) || purpose?.startsWith('team-plan:') === true;
}
export function isLocalChildWorkerSession(session) {
    if (!session.parentSessionId)
        return false;
    if (session.sessionKind === 'task')
        return true;
    if (session.sessionType !== 'branch' || session.visibility !== 'hidden')
        return false;
    // Existing Team workers may already carry the persisted 'conversation' default.
    // Match Session System's durable Task-purpose fallback; kind-less compatibility
    // callers additionally retain the old structural policy.
    return session.sessionKind === undefined || isLocalTaskWorkerPurpose(session.purpose?.trim());
}
/**
 * Child Sessions whose Turns the parent timeline records as Subagent executions:
 * delegated workers (Task, background Task, code review, Team). An allowlist, so a new
 * kind of parented Session (like peek and cron before it) stays out until it opts in.
 * Goal verification is an internal check the Subagent panel hides, so it writes no
 * parent execution rows either.
 */
export function isSubagentExecutionChild(session) {
    return isLocalChildWorkerSession(session) && !isGoalVerifierTaskPurpose(session.purpose);
}
/**
 * Default sidebar tree projection.
 *
 * Task workers remain hidden from flat/search/project projections, but their
 * known purpose makes them durable sidebar children after refresh. Other
 * hidden children and top-level/system sessions stay out of this projection.
 */
export function isLocalSidebarTreeSession(session) {
    return (session.visibility !== 'hidden' ||
        (isLocalChildWorkerSession(session) && isLocalTaskWorkerPurpose(session.purpose)));
}
//# sourceMappingURL=session-policy.js.map