/**
 * Only work the Goal delegated and needs back can hold it: a subagent or a
 * workflow. A background shell (a dev server, a watcher) runs on its own and
 * the model checks on it itself, so it never blocks the Goal (spec §8, §17).
 */
const GOAL_DEPENDENCY_TASK_KINDS = ['subagent', 'workflow'];
/** Tool call id prefix of the Goal verifier's delegated run. */
const GOAL_VERIFIER_TOOL_CALL_PREFIX = 'goal-verifier:';
/**
 * Normalizes every external Goal dependency gate behind fail-closed reads.
 * Callbacks are required so a missing host wire can never become permission
 * to continue; test harnesses must opt into an explicit false result.
 */
export class GoalDependencyGates {
    callbacks;
    failures;
    backgroundWaits;
    constructor(callbacks, failures, backgroundWaits) {
        this.callbacks = callbacks;
        this.failures = failures;
        this.backgroundWaits = backgroundWaits;
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
     *
     * `'unreadable'` when the task list cannot be read: still a blocker (the
     * gate stays fail-closed), but one the Goal reports as such instead of
     * pretending to wait for tasks. Every read is recorded so the wait shows
     * which tasks hold the Goal (spec G2-07).
     */
    async hasRequiredBackgroundWork(sessionId, goalId) {
        const read = await this.readBackgroundWork(sessionId, goalId);
        this.backgroundWaits.record(goalId, read);
        if (!read.readable)
            return 'unreadable';
        return read.waitedTasks.length > 0;
    }
    /**
     * The waited list is exactly the gate's dependency set. The finished count
     * covers the same family once ended: background subagents and workflows
     * this Goal's own Turns started. A foreground delegation or the Goal
     * verifier never waits in the background, so neither counts.
     */
    async readBackgroundWork(sessionId, goalId) {
        try {
            const turns = this.callbacks.goalTurns(goalId);
            const unfinished = await this.callbacks.listUnfinishedBackgroundTasks(sessionId, GOAL_DEPENDENCY_TASK_KINDS);
            const waitedTasks = unfinished.filter((task) => isGoalTask(task, turns)).map(toWaitedTask);
            if (waitedTasks.length === 0)
                return { readable: true, waitedTasks, finishedTaskCount: 0 };
            const finished = (await this.callbacks.listFinishedBackgroundTasks?.(sessionId, GOAL_DEPENDENCY_TASK_KINDS)) ?? [];
            const finishedTaskCount = finished.filter((task) => isGoalTask(task, turns) && isBackgroundDelegation(task)).length;
            return { readable: true, waitedTasks, finishedTaskCount };
        }
        catch (error) {
            this.report(sessionId, 'thread_goal_background_guard_failed', error);
            return { readable: false };
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
function isGoalTask(task, turns) {
    return (GOAL_DEPENDENCY_TASK_KINDS.some((kind) => kind === task.kind) &&
        task.startedByTurnId !== undefined &&
        turns.has(task.startedByTurnId));
}
/** Rows without an execution mode predate foreground rows and ran in the background. */
function isBackgroundDelegation(task) {
    if (task.toolCallId?.startsWith(GOAL_VERIFIER_TOOL_CALL_PREFIX))
        return false;
    return task.executionMode === undefined || task.executionMode === 'background';
}
function toWaitedTask(task) {
    return {
        taskId: task.taskId ?? '',
        name: task.name ?? task.kind,
        startedAt: task.startedAt ?? 0,
    };
}
/** Reads the host's raw task rows as the facts the dependency gate decides on. */
export function readBackgroundTaskFacts(read) {
    return async (sessionId, kinds) => (await read(sessionId, kinds)).map(toGoalBackgroundTaskFact);
}
/**
 * Every local task row records the Turn whose tool call started it. A task
 * without a description shows the delegated agent name; one not started yet
 * shows its creation time.
 */
function toGoalBackgroundTaskFact(task) {
    const parentTurnId = readNonEmptyString(task.metadata?.parentTurnId);
    const executionMode = readNonEmptyString(task.metadata?.executionMode);
    const name = readNonEmptyString(task.description) ??
        readNonEmptyString(task.metadata?.agentName) ??
        task.kind;
    return {
        kind: task.kind,
        ...(parentTurnId ? { startedByTurnId: parentTurnId } : {}),
        taskId: task.taskId,
        name,
        startedAt: task.startedAt ?? task.createdAt,
        ...(executionMode ? { executionMode } : {}),
        ...(task.toolCallId ? { toolCallId: task.toolCallId } : {}),
    };
}
function readNonEmptyString(value) {
    return typeof value === 'string' && value.trim() ? value : undefined;
}
//# sourceMappingURL=dependency-gates.js.map