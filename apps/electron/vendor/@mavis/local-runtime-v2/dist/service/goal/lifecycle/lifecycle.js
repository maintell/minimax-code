import { isAwaitingUsageRecovery, ThreadGoalEpochConflictError, ThreadGoalStatusConflictError, } from '@mavis/goal';
import { ThreadGoalAutomationOwnerConflictError, ThreadGoalSessionNotFoundError, ThreadGoalVerifierSessionError, } from './gate.js';
import { isStatusOnlyResume, restartsOrRetargetsGoal, withUserStatusReason, } from './lifecycle-patch-intent.js';
import { buildThreadGoalRuntimeTools, publishThreadGoalEvent } from '../observability/wiring.js';
import { withPreparedGoalResources } from './objective-resources.js';
import { rejectTokenBudgetMutation, tokenBudgetConflictResult } from './token-budget-mutation.js';
import { isCurrentEpochThreadGoalContinuation } from '../continuation/kickoff.js';
const HANDED_OFF = { kind: 'handed_off' };
/**
 * Every resume — the user's explicit one and automatic quota recovery — ends
 * the pause a stop or a final failure left: an ordinary Turn's failure does not
 * hold back a Goal that should run, the same as for an active Goal (spec §6).
 */
const RESUME_PAUSES = ['user-stop', 'turn-final-failure'];
/** Owns CRUD, pause/resume, tool exposure, and live response projection. */
export class GoalLifecycle {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async createGoal(input, options = {}) {
        if (!(await this.deps.sessionExists(input.sessionId))) {
            throw new ThreadGoalSessionNotFoundError(input.sessionId);
        }
        if (await this.deps.gates.isGoalVerifierChildSession(input.sessionId)) {
            throw new ThreadGoalVerifierSessionError(input.sessionId);
        }
        if (await this.deps.gates.hasAutomationOwnerConflict(input.sessionId)) {
            throw new ThreadGoalAutomationOwnerConflictError(input.sessionId);
        }
        const created = await withPreparedGoalResources(this.deps.objectiveAssets, input.sessionId, input.objectiveResources, (objectiveResources) => this.deps.store().create({ ...input, objectiveResources }));
        this.deps.runtime.emitRuntimeEvent({
            type: 'goal.created',
            at: this.deps.runtime.nowMs(),
            payload: {
                goalId: created.goalId,
                sessionId: created.sessionId,
            },
        });
        if (!options.requireKickoffAdmission) {
            await this.handleCreated(created);
            return created;
        }
        try {
            await this.deps.continuation.reconcileInitial(created, false);
        }
        catch (error) {
            await this.deps.continuation.rollbackFailedCreation(created);
            throw error;
        }
        publishThreadGoalEvent(this.deps.runtime.publishGlobalEvent, {
            type: 'created',
            goal: created,
        });
        this.deps.continuation.requestQueueDispatch(created.sessionId);
        return created;
    }
    /**
     * Pause the Goal a user is explicitly leaving, as one atomic transition.
     *
     * This is deliberately a separate entry point rather than a shape match
     * inside `patchGoal`. "The user pressed stop" is an intent, and inferring it
     * from which patch fields happen to be absent fails silently: any layer that
     * adds one more field (a derived `statusReason`, an optimistic-concurrency
     * guard) downgrades the caller to a plain field patch with no error and no
     * log. Routing on the intent at the wire boundary keeps that impossible.
     *
     * `pauseByUser` touches an `active` Goal and one waiting on the account
     * quota (spec §9: a pause always takes effect; §7: a Goal paused while it
     * waits on the quota does not resume on its own). A Goal that already
     * settled into `complete`, `blocked`, or `budget_limited` is reported back
     * unchanged instead of being rewritten to `paused`.
     */
    async pauseGoalByUser(sessionId) {
        const existing = await this.deps.store().getBySession(sessionId);
        if (!existing)
            return undefined;
        this.deps.runtime.abortVerification(sessionId, 'paused(user_requested)');
        const paused = await this.deps.store().pauseByUser(sessionId, 'paused(user_requested)');
        // A CAS miss proves `existing` is stale: the row was pausable when we read
        // it and is not now. Passing it as `persistedState` would suppress the
        // re-read and report the concurrent winner's Goal back as `active`.
        if (!paused)
            return this.getGoalForResponse(sessionId);
        this.deps.usageRecoveryRetention.forget(paused.goalId);
        this.deps.runtime.emitStateTransition(existing.status, paused);
        const projected = (await this.getGoalForResponse(sessionId, paused)) ?? paused;
        this.deps.runtime.handleChanged({ type: 'updated', goal: projected, userPatch: true });
        await this.abortRunningGoalTurn(sessionId, paused.goalId, 'pause');
        // Aborting settles usage and advances the decision epoch. Return the
        // durable post-abort snapshot so the next objective edit has a valid CAS.
        return this.getGoalForResponse(sessionId);
    }
    async patchGoal(sessionId, patch) {
        return (await this.patchGoalWithOutcome(sessionId, patch))?.goal;
    }
    /**
     * Apply a user patch. When the patch brings a stopped Goal back to `active`
     * the call does not return until that resume has landed (spec §6): a Goal
     * Turn was admitted, the Goal waits on a recorded reason, or the resume
     * failed and the Goal was stopped again (thrown).
     */
    async patchGoalWithOutcome(sessionId, patch) {
        const existing = await this.deps.store().getBySession(sessionId);
        if (!existing)
            return undefined;
        await this.assertUserPatchAllowed(sessionId, existing, patch);
        if (isStatusOnlyResume(patch) && existing.status === 'active') {
            return this.resumeActiveGoal(existing, patch);
        }
        if (patch.status === 'active' && existing.status === 'paused') {
            await this.getGoalForResponse(sessionId, existing);
        }
        const updated = await this.writeUserPatchOrObserveResume(sessionId, existing, patch);
        if (!updated)
            return this.resumeRacedGoal(sessionId, patch);
        return this.publishUserPatch(existing, updated, patch);
    }
    async publishUserPatch(existing, updated, patch) {
        const { sessionId } = updated;
        this.deps.runtime.emitStateTransition(existing.status, updated);
        const shouldProjectRunningTime = patch.status === 'paused' || patch.status === 'active';
        const projected = shouldProjectRunningTime
            ? ((await this.getGoalForResponse(sessionId, updated)) ?? updated)
            : updated;
        const event = userPatchChangedEvent({ existing, updated, projected, patch });
        if (existing.status === 'active' || updated.status !== 'active') {
            this.deps.runtime.handleChanged(event);
            if (patch.status === 'paused') {
                await this.abortRunningGoalTurn(sessionId, updated.goalId, 'pause');
            }
            return { goal: projected };
        }
        return this.landUserResume(existing, updated, projected, event);
    }
    /**
     * A user patch brought a stopped Goal back to `active`: end the Queue pause
     * its stop may have left, then hand the Goal its next Turn and report what
     * that led to (spec §6).
     */
    async landUserResume(existing, updated, projected, event) {
        // A resume before the quota reset is a real attempt (spec §7): the quota
        // may be back already (credits, a plan upgrade). If the attempt hits the
        // same quota, the Goal returns to the schedule it had.
        if (isAwaitingUsageRecovery(existing)) {
            this.deps.usageRecoveryRetention.retain(updated.goalId, updated.updatedAt, existing.usageRecoveryAtMs);
        }
        const resume = await this.deps.resumes.resolve(updated, await this.handOffResumedGoal(updated.sessionId, event, RESUME_PAUSES));
        return { goal: await this.latestGoalForResponse(projected), resume };
    }
    /** End a stop's Queue pause, then hand the reactivated Goal its next Turn. */
    async handOffResumedGoal(sessionId, event, pauses) {
        const queue = await this.continueStoppedQueue(sessionId, pauses);
        return queue.kind === 'failed' ? queue : this.deps.runtime.applyChange(event);
    }
    /**
     * A resume is the Goal returning to this Session's work, so it ends the
     * Queue pause a stop or a final failure left behind while work was pending;
     * otherwise the continuation would park behind it with nothing to start it.
     * A failure is reported and handed to the caller, which fails the resume.
     */
    async continueStoppedQueue(sessionId, pauses) {
        if (!this.deps.endStoppedQueuePause)
            return { kind: 'untouched' };
        try {
            return {
                kind: (await this.deps.endStoppedQueuePause(sessionId, pauses)) ? 'continued' : 'untouched',
            };
        }
        catch (error) {
            this.deps.runtime.reportFailure(sessionId, `thread_goal_resume_queue_continue_failed:${this.deps.runtime.formatError(error)}`);
            return { kind: 'failed', error };
        }
    }
    /**
     * An ordinary Turn — not a Goal Turn — finally failed. Its failure paused the
     * Session Queue because work was still pending; when that work includes the
     * still-`active` Goal's continuation at its current epoch, the pause would
     * leave the Goal `active` with no Turn, no wait reason and nothing that ever
     * starts it (spec §6). The Goal is the user's standing instruction to keep
     * working, so that pause ends and the Queue is woken.
     *
     * Only that one failure pause ends: FIFO order holds, so a message queued
     * ahead of the continuation still runs first; the failed Turn keeps its
     * failure and is not replayed; a stop's pause and every other Queue gate
     * stay. A Goal that is paused, deleted or replaced, or that has no current
     * continuation queued, leaves the pause to the user. A Goal Turn that then
     * fails settles through its own failure classification, so this never
     * loops. A failure is reported; no entry point is waiting on it.
     */
    async continueAfterOrdinaryTurnFailure(turn) {
        const release = this.deps.releaseFailedTurnPause;
        if (!release || !this.deps.runtime.isEnabled())
            return;
        try {
            const goal = await this.deps.store().getBySession(turn.sessionId);
            if (goal?.status !== 'active')
                return;
            const released = await release({
                sessionId: turn.sessionId,
                turnId: turn.turnId,
                awaited: (items) => items.some((item) => isCurrentEpochThreadGoalContinuation(item, goal)),
            });
            if (released)
                this.deps.continuation.requestQueueDispatch(turn.sessionId);
        }
        catch (error) {
            this.deps.runtime.reportFailure(turn.sessionId, `thread_goal_failed_turn_queue_continue_failed:${this.deps.runtime.formatError(error)}`);
        }
    }
    /**
     * The Goal as it stands after a resume landed — possibly already waiting on a
     * recorded reason — or `fallback` when the row moved to another Goal or back
     * behind the epoch the caller already holds.
     */
    async latestGoalForResponse(fallback) {
        const latest = await this.getGoalForResponse(fallback.sessionId);
        return latest?.goalId === fallback.goalId && latest.updatedAt >= fallback.updatedAt
            ? latest
            : fallback;
    }
    /**
     * Resume the Goal the automatic account-quota recovery just reactivated. It
     * lands exactly like a manual resume; a failure is reported rather than
     * thrown because no entry point is waiting on it.
     *
     * That includes ending the Queue pause an ordinary Turn left while the Goal
     * waited on the quota. Stopping such a Turn never paused the Goal, and its
     * final failure did not either, so the scheduled continuation still stands
     * (spec §7); behind either pause it could never start (spec §6). Messages
     * queued before the Goal's continuation run first, in FIFO order, and the
     * failed Turn is not replayed.
     */
    async landUsageRecoveryResume(goal) {
        this.deps.runtime.emitStateTransition('usage_limited', goal);
        try {
            await this.deps.resumes.resolve(goal, await this.handOffResumedGoal(goal.sessionId, {
                type: 'updated',
                goal,
                userPatch: true,
                resumedFromReason: 'usage_limited(provider_quota)',
            }, RESUME_PAUSES));
        }
        catch (error) {
            this.deps.runtime.reportFailure(goal.sessionId, `thread_goal_usage_recovery_resume_failed:${this.deps.runtime.formatError(error)}`);
        }
    }
    /**
     * A repeated resume of a Goal that is already `active` must not advance the
     * decision epoch: that would invalidate the Goal Turn the first resume just
     * started and schedule a second one. It only makes sure something runs the
     * Goal — and reports what that is.
     */
    async resumeActiveGoal(existing, patch) {
        const expectedEpoch = patch.rejectIfUpdatedAtChangedFrom;
        if (expectedEpoch !== undefined && expectedEpoch !== existing.updatedAt) {
            throw new ThreadGoalEpochConflictError(existing.goalId, expectedEpoch, existing.updatedAt);
        }
        const queue = await this.continueStoppedQueue(existing.sessionId, RESUME_PAUSES);
        const resume = await this.deps.resumes.resolve(existing, await this.kickActiveGoal(existing, queue));
        return { goal: await this.latestGoalForResponse(existing), resume };
    }
    /**
     * Make sure something runs an already `active` Goal. A runner that exists
     * keeps the Goal even if the Queue pause could not be ended; a continuation
     * parked behind a pause that just ended is re-examined right away.
     */
    async kickActiveGoal(goal, queue) {
        if (this.hasRunner(goal)) {
            if (queue.kind === 'continued')
                this.deps.continuation.requestQueueDispatch(goal.sessionId);
            return HANDED_OFF;
        }
        return queue.kind === 'failed' ? queue : this.deps.continuation.kickCurrent(goal);
    }
    /** A concurrent resume reactivated the Goal between our read and our write. */
    async resumeRacedGoal(sessionId, patch) {
        const current = await this.deps.store().getBySession(sessionId);
        if (!current)
            return undefined;
        return this.resumeActiveGoal(current, patch);
    }
    /** Something already runs this Goal: a Turn in its Session, or a recorded wait. */
    hasRunner(goal) {
        return goal.executionWait !== null || this.deps.gates.isSessionBusy(goal.sessionId);
    }
    async updateTokenBudget(context, input) {
        const existing = await this.deps.store().getBySession(context.sessionId);
        if (!existing) {
            return { updated: false, error: 'cannot update goal because this thread has no goal' };
        }
        const rejected = rejectTokenBudgetMutation(existing, input);
        if (rejected)
            return rejected;
        const resumed = existing.status === 'budget_limited';
        let updated;
        try {
            updated = await this.deps.store().patchByUser(existing.goalId, {
                tokenBudget: input.tokenBudget,
                rejectIfUpdatedAtChangedFrom: input.expectedUpdatedAt,
                ...(resumed ? { status: 'active', statusReason: null } : {}),
            });
        }
        catch (error) {
            const currentGoal = await this.deps.store().getBySession(context.sessionId);
            const conflict = tokenBudgetConflictResult(error, currentGoal);
            if (conflict)
                return conflict;
            throw error;
        }
        this.deps.runtime.emitStateTransition(existing.status, updated);
        this.deps.runtime.handleChanged({
            type: 'updated',
            goal: updated,
            userPatch: true,
            ...(resumed && existing.statusReason ? { resumedFromReason: existing.statusReason } : {}),
        });
        this.deps.runtime.emitRuntimeEvent({
            type: 'goal.budget_updated',
            at: this.deps.runtime.nowMs(),
            payload: {
                goalId: updated.goalId,
                sessionId: updated.sessionId,
                turnId: context.turnId,
                ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
                oldTokenBudget: existing.tokenBudget,
                newTokenBudget: updated.tokenBudget,
                status: updated.status,
                resumed,
            },
        });
        return {
            updated: true,
            goal: updated,
            previousTokenBudget: existing.tokenBudget,
            resumed,
        };
    }
    async assertUserPatchAllowed(sessionId, existing, patch) {
        // Reactivating or re-aiming a Goal on a verifier child would restart the
        // same stuck loop. Pausing and clearing stay open below so a Goal an
        // earlier build already stored there can still be stopped and removed.
        if (restartsOrRetargetsGoal(patch) &&
            (await this.deps.gates.isGoalVerifierChildSession(sessionId))) {
            throw new ThreadGoalVerifierSessionError(sessionId);
        }
        if (patch.expectedGoalId !== undefined && patch.expectedGoalId !== existing.goalId) {
            throw Object.assign(new Error('Goal changed before the objective could be saved.'), {
                statusCode: 409,
                code: 'GOAL_CHANGED',
            });
        }
    }
    /**
     * Write the patch; a bare resume is guarded against a Goal that turned
     * `active` meanwhile. `undefined` means a concurrent resume won that race.
     */
    async writeUserPatchOrObserveResume(sessionId, existing, patch) {
        if (!isStatusOnlyResume(patch))
            return this.writeUserPatch(sessionId, existing, patch);
        try {
            return await this.writeUserPatch(sessionId, existing, {
                ...patch,
                rejectIfCurrentStatus: 'active',
            });
        }
        catch (error) {
            if (error instanceof ThreadGoalStatusConflictError && error.currentStatus === 'active') {
                return undefined;
            }
            throw error;
        }
    }
    writeUserPatch(sessionId, existing, patch) {
        return withPreparedGoalResources(this.deps.objectiveAssets, sessionId, patch.objectiveResources, (objectiveResources) => this.deps.store().patchByUser(existing.goalId, withUserStatusReason({
            ...patch,
            ...(objectiveResources !== undefined
                ? {
                    objectiveResources,
                    rejectIfUpdatedAtChangedFrom: patch.rejectIfUpdatedAtChangedFrom ?? existing.updatedAt,
                }
                : {}),
        })));
    }
    /**
     * Hide a completed Goal's notice on every client. Display state only: it
     * publishes the Goal without entering the user-patch execution path.
     */
    async dismissGoal(sessionId, goalId) {
        const dismissed = await this.deps.store().dismissCompleted(sessionId, goalId);
        publishThreadGoalEvent(this.deps.runtime.publishGlobalEvent, {
            type: 'updated',
            goal: dismissed,
        });
        return dismissed;
    }
    /**
     * The user deletes the Goal. The Goal Turn running now is not stopped: it
     * leaves the Goal and runs to its own end as an ordinary Turn, with no Goal
     * verification or continuation after it; the user stops it like any other
     * Turn. It is detached before the Goal row goes, so none of its requests or
     * tools sees a binding to a missing Goal and winds the Turn down.
     */
    async deleteGoal(sessionId) {
        const existing = await this.deps.store().getBySession(sessionId);
        if (!existing)
            return false;
        const runningTurnId = this.runningGoalTurnId(sessionId, existing.goalId);
        const detached = runningTurnId
            ? this.deps.turnContext.detach(sessionId, runningTurnId)
            : undefined;
        try {
            await this.deleteGoalRow(existing);
        }
        catch (error) {
            // The Goal is still there: its Turn goes on working for it.
            if (runningTurnId && detached) {
                this.deps.turnContext.reattach(sessionId, runningTurnId, detached);
            }
            throw error;
        }
        this.announceDeleted(sessionId, existing);
        return true;
    }
    /**
     * 只在 `matches` 接受时删除会话的目标，返回删掉的目标。用于内容安审撤回首轮：
     * 绑定这个目标、仍在运行的轮次照旧中止。`endingTurnId` 是已经在自行结束的轮次
     * （被撤回的那一轮）：在它自己的处理过程中中止它，只会干等它释放。
     */
    async deleteGoalIf(sessionId, matches, endingTurnId) {
        const existing = await this.deps.store().getBySession(sessionId);
        if (!existing || !matches(existing))
            return undefined;
        await this.deleteGoalRow(existing);
        this.announceDeleted(sessionId, existing);
        await this.abortRunningGoalTurn(sessionId, existing.goalId, 'clear', endingTurnId);
        return existing;
    }
    async deleteGoalRow(existing) {
        await this.deps.continuation.cancelInitial(existing);
        await this.deps.store().delete(existing.goalId);
    }
    announceDeleted(sessionId, existing) {
        this.deps.usageRecoveryRetention.forget(existing.goalId);
        this.deps.runtime.handleChanged({
            type: 'deleted',
            goalId: existing.goalId,
            sessionId,
            kickoffCancelled: true,
        });
    }
    async pauseActiveGoalForAbort(sessionId) {
        await this.pauseActiveGoal(sessionId, 'paused(user_requested)', 'thread_goal_abort_pause_failed');
    }
    async pauseActiveGoalForRetraction(sessionId) {
        return this.pauseActiveGoal(sessionId, 'paused(retracted)', 'thread_goal_retraction_pause_failed');
    }
    /**
     * The Goal Turn running in this Session: the Turn a pause of its Goal stops
     * and the user's deletion of its Goal detaches. A Turn is a Goal Turn when admission bound it to the Goal,
     * including a reply to the Goal's questionnaire, not by the source that
     * queued it. With `goalId`, only a Turn bound to that Goal counts. Undefined
     * when no Turn runs or the running one is not a Goal Turn, which then keeps
     * running.
     */
    runningGoalTurnId(sessionId, goalId) {
        const timing = this.deps.turnTimingReader.getBySession(sessionId);
        if (!timing)
            return undefined;
        const boundGoalId = this.deps.turnContext.goalIdForTurn(sessionId, timing.turnId);
        if (!boundGoalId || (goalId !== undefined && boundGoalId !== goalId))
            return undefined;
        return timing.turnId;
    }
    async abortRunningGoalTurn(sessionId, goalId, action, endingTurnId) {
        const turnId = this.runningGoalTurnId(sessionId, goalId);
        if (!turnId || turnId === endingTurnId || !this.deps.abortThreadGoalTurn)
            return;
        try {
            await this.deps.abortThreadGoalTurn(sessionId, turnId);
        }
        catch (error) {
            this.deps.runtime.reportFailure(sessionId, `thread_goal_${action}_abort_failed:${this.deps.runtime.formatError(error)}`);
        }
    }
    async runtimeToolsFor(disabled, _sessionId) {
        if (!this.deps.runtime.isEnabled() || disabled)
            return [];
        return buildThreadGoalRuntimeTools(this.deps.store(), false, this.deps.signalCollector, {
            updateTokenBudget: (context, input) => this.updateTokenBudget(context, input),
        });
    }
    async getGoalForResponse(sessionId, persistedState) {
        const persisted = persistedState ?? (await this.deps.store().getBySession(sessionId));
        if (!persisted) {
            this.deps.timeAccounting.clearSession(sessionId);
            return undefined;
        }
        const timing = this.deps.turnTimingReader.getBySession(sessionId);
        if (!timing)
            return persisted;
        const bound = this.deps.turnContext.getBinding(timing.turnId)?.binding;
        if (!bound || bound.goalId !== persisted.goalId)
            return persisted;
        if (this.deps.turnContext.hasAccounting(timing.turnId)) {
            const authoritative = await this.deps.store().getBySession(sessionId);
            if (!authoritative)
                this.deps.timeAccounting.clearSession(sessionId);
            return authoritative;
        }
        return this.deps.timeAccounting.project(persisted, timing);
    }
    handleTurnTimingFinished(timing) {
        this.deps.timeAccounting.finish(timing);
        this.deps.turnContext.finish(timing);
    }
    async handleCreated(goal) {
        if (!this.deps.runtime.isEnabled())
            return;
        publishThreadGoalEvent(this.deps.runtime.publishGlobalEvent, { type: 'created', goal });
        try {
            await this.deps.continuation.reconcileInitial(goal, true);
        }
        catch (error) {
            this.deps.runtime.reportFailure(goal.sessionId, `thread_goal_kickoff_materialize_failed:${this.deps.runtime.formatError(error)}`);
        }
    }
    async recoverInitialContinuation(goal) {
        await this.deps.continuation.reconcileInitial(goal, false);
    }
    async pauseActiveGoal(sessionId, reason, failureCode) {
        if (!this.deps.runtime.isEnabled())
            return undefined;
        this.deps.runtime.abortVerification(sessionId, reason);
        try {
            const paused = await this.deps.store().pauseActiveBySession(sessionId, reason);
            if (!paused)
                return undefined;
            this.deps.runtime.emitStateTransition('active', paused);
            const goalForResponse = (await this.getGoalForResponse(sessionId, paused)) ?? paused;
            const pausedForResponse = goalForResponse.goalId === paused.goalId ? goalForResponse : paused;
            this.deps.runtime.handleChanged({ type: 'updated', goal: pausedForResponse });
            return pausedForResponse;
        }
        catch (error) {
            this.deps.runtime.reportFailure(sessionId, `${failureCode}:${this.deps.runtime.formatError(error)}`);
            return undefined;
        }
    }
}
function userPatchChangedEvent({ existing, updated, projected, patch, }) {
    // Any write that reactivates a stopped Goal — an explicit resume or a budget
    // change that lifts a budget stop — resumes from that stop's reason.
    const resumedFromReason = projected.status === 'active' && existing.status !== 'active' ? existing.statusReason : null;
    const objectiveChanged = (patch.objective !== undefined && patch.objective !== existing.objective) ||
        JSON.stringify(updated.objectiveResources ?? []) !==
            JSON.stringify(existing.objectiveResources ?? []);
    return {
        type: 'updated',
        goal: projected,
        userPatch: true,
        ...(resumedFromReason ? { resumedFromReason } : {}),
        ...(objectiveChanged ? { objectiveChanged: true } : {}),
    };
}
//# sourceMappingURL=lifecycle.js.map