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
    async hasRequiredBackgroundWork(sessionId) {
        try {
            return await this.callbacks.hasRequiredBackgroundWork(sessionId);
        }
        catch (error) {
            this.report(sessionId, 'thread_goal_background_guard_failed', error);
            return true;
        }
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