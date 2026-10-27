const GOAL_RESUME_FAILED = 'GOAL_RESUME_FAILED';
/**
 * A resume could neither start a Goal Turn nor queue one behind a recorded
 * wait. The Goal has already been put back into a stopped state, so the entry
 * point reports the failure and the Goal's state says the same thing.
 */
/** @internal Exported for the resume-landing integration tests. */
export class ThreadGoalResumeFailedError extends Error {
    goalId;
    name = 'ThreadGoalResumeFailedError';
    statusCode = 503;
    code = GOAL_RESUME_FAILED;
    constructor(goalId, cause) {
        super(`The goal could not be resumed: ${cause instanceof Error ? cause.message : String(cause)}`);
        this.goalId = goalId;
    }
}
/**
 * Turns "the Goal is `active` again and its continuation was handed off" into
 * one of the three results a resume may have (spec §6): a Goal Turn started,
 * the Goal waits on a recorded reason, or the resume failed.
 *
 * The facts are read back rather than predicted. The continuation goes through
 * the Queue, whose dispatch has already run by the time this is asked: either
 * the Goal Turn was admitted (the admission commit recorded it in
 * {@link GoalTurnHistory}), or the Queue deferred it and stored the wait reason
 * on the Goal, or it sits behind work already running in the Session.
 */
export class GoalResumeOutcomes {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async resolve(goal, kick) {
        if (kick.kind === 'failed') {
            await this.stopFailedResume(goal);
            throw new ThreadGoalResumeFailedError(goal.goalId, kick.error);
        }
        const startedTurnId = this.startedTurnId(goal, kick);
        if (startedTurnId)
            return { kind: 'started', turnId: startedTurnId };
        const current = await this.deps.store().getBySession(goal.sessionId);
        if (!current || current.goalId !== goal.goalId)
            return { kind: 'not_resumed' };
        if (current.status !== 'active')
            return { kind: 'not_resumed', status: current.status };
        if (current.executionWait)
            return { kind: 'waiting', reason: current.executionWait.reason };
        return { kind: 'queued' };
    }
    /**
     * A Turn counts as started by this resume only when it is bound to this Goal
     * at the resumed epoch or later. A Turn still winding down from before the
     * pause is bound to an older epoch and never counts.
     */
    startedTurnId(goal, kick) {
        const kickedTurnId = kick.kind === 'submitted' || kick.kind === 'steered' ? kick.turnId : undefined;
        if (kickedTurnId && this.deps.turnHistory.has(goal.goalId, kickedTurnId))
            return kickedTurnId;
        const running = this.deps.turnTimingReader.getBySession(goal.sessionId);
        if (!running)
            return undefined;
        const binding = this.deps.turnContext.getBinding(running.turnId)?.binding;
        return binding?.goalId === goal.goalId && binding.admittedGoalUpdatedAt >= goal.updatedAt
            ? running.turnId
            : undefined;
    }
    /**
     * Never leave a Goal `active` with nothing to run it. The guarded write only
     * lands on the epoch this resume created, so a concurrent pause, edit or
     * delete keeps its own result.
     */
    async stopFailedResume(goal) {
        const stopped = await this.deps.store().transitionActiveAtEpoch(goal.goalId, goal.updatedAt, {
            status: 'paused',
            statusReason: 'paused(infra_retryable)',
        });
        if (!stopped)
            return;
        this.deps.emitStateTransition('active', stopped);
        this.deps.handleChanged({ type: 'updated', goal: stopped });
    }
}
//# sourceMappingURL=resume.js.map