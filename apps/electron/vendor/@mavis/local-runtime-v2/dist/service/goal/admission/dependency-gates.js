/**
 * Only work the Goal delegated and needs back can hold it: a subagent or a
 * workflow. A background shell (a dev server, a watcher) runs on its own and
 * the model checks on it itself, so it never blocks the Goal (spec §8, §17).
 */
const GOAL_DEPENDENCY_TASK_KINDS = [
    'subagent',
    'workflow',
];
/**
 * Normalizes every external Goal dependency gate behind fail-closed reads.
 * Callbacks are required so a missing host wire can never become permission
 * to continue; test harnesses must opt into an explicit false result.
 */
export class GoalDependencyGates {
    callbacks;
    failures;
    constructor(callbacks, failures) {
        this.callbacks = callbacks;
        this.failures = failures;
    }
    isSessionBusy(sessionId) {
        return this.callbacks.isSessionBusy(sessionId);
    }
    async hasPendingQuestionnaire(sessionId, expectedGoalId) {
        try {
            return await this.callbacks.hasPendingQuestionnaire(sessionId, expectedGoalId);
        }
        catch (error) {
            this.report(sessionId, 'thread_goal_questionnaire_guard_failed', error);
            return true;
        }
    }
    async hasPendingPermission(sessionId) {
        try {
            return await this.callbacks.hasPendingPermission(sessionId);
        }
        catch (error) {
            this.report(sessionId, 'thread_goal_permission_guard_failed', error);
            return true;
        }
    }
    async hasAutomationOwnerConflict(sessionId) {
        try {
            return await this.callbacks.hasAutomationOwnerConflict(sessionId);
        }
        catch (error) {
            this.report(sessionId, 'thread_goal_automation_owner_guard_failed', error);
            return true;
        }
    }
    /**
     * True while this Goal has an unfinished dependency: a subagent or workflow
     * task that one of its own Goal Turns started. Background work started by an
     * ordinary conversation Turn, or by a previous Goal in the Session, never
     * holds this Goal.
     */
    async hasRequiredBackgroundWork(sessionId, goalId) {
        try {
            const tasks = await this.callbacks.listUnfinishedBackgroundTasks(sessionId, GOAL_DEPENDENCY_TASK_KINDS);
            return tasks.some((task) => this.isGoalDependency(goalId, task));
        }
        catch (error) {
            this.report(sessionId, 'thread_goal_background_guard_failed', error);
            return true;
        }
    }
    isGoalDependency(goalId, task) {
        return (GOAL_DEPENDENCY_TASK_KINDS.some((kind) => kind === task.kind) &&
            task.startedByTurnId !== undefined &&
            this.callbacks.isGoalTurn(goalId, task.startedByTurnId));
    }
    /**
     * Fail-closed like every other gate: if the session cannot be read, treat it
     * as a verifier child and refuse to start or reactivate a Goal on it. A
     * failed lookup must never become permission to bind a Goal to a session
     * that cannot run one.
     */
    async isGoalVerifierChildSession(sessionId) {
        try {
            return await this.callbacks.isGoalVerifierChildSession(sessionId);
        }
        catch (error) {
            this.report(sessionId, 'thread_goal_verifier_session_guard_failed', error);
            return true;
        }
    }
    report(sessionId, failureCode, error) {
        this.failures.report(sessionId, `${failureCode}:${this.failures.format(error)}`);
    }
}
//# sourceMappingURL=dependency-gates.js.map