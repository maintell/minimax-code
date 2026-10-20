import { ThreadGoalBudgetLimitedError, ThreadGoalEpochConflictError, ThreadGoalTokenBudgetExhaustedError, } from '@mavis/goal';
import { sumPiTurnUsageTokens } from '../usage/api.js';
import { ThreadGoalAutomationOwnerConflictError, ThreadGoalSessionNotFoundError, ThreadGoalVerifierSessionError, } from './gate.js';
import { buildThreadGoalRuntimeTools, publishThreadGoalEvent } from './wiring.js';
import { withPreparedGoalResources } from './objective-resources.js';
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
        const created = await withPreparedGoalResources(this.deps.dataDir, input.sessionId, input.objectiveResources, (objectiveResources) => this.deps.store().create({ ...input, objectiveResources }));
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
     * `pauseActiveBySession` only touches an `active` row, so a Goal that already
     * settled into `complete`, `blocked`, or `budget_limited` is reported back
     * unchanged instead of being rewritten to `paused`.
     */
    async pauseGoalByUser(sessionId) {
        const existing = await this.deps.store().getBySession(sessionId);
        if (!existing)
            return undefined;
        this.deps.runtime.abortVerification(sessionId, 'paused(user_requested)');
        const paused = await this.deps
            .store()
            .pauseActiveBySession(sessionId, 'paused(user_requested)');
        // A CAS miss proves `existing` is stale: the row was `active` when we read
        // it and is not now. Passing it as `persistedState` would suppress the
        // re-read and report the concurrent winner's Goal back as `active`.
        if (!paused)
            return this.getGoalForResponse(sessionId);
        this.deps.runtime.emitStateTransition(existing.status, paused);
        const projected = (await this.getGoalForResponse(sessionId, paused)) ?? paused;
        this.deps.runtime.handleChanged({ type: 'updated', goal: projected, userPatch: true });
        await this.abortPausedThreadGoalTurn(sessionId);
        // Aborting settles usage and advances the decision epoch. Return the
        // durable post-abort snapshot so the next objective edit has a valid CAS.
        return this.getGoalForResponse(sessionId);
    }
    async patchGoal(sessionId, patch) {
        const existing = await this.deps.store().getBySession(sessionId);
        if (!existing)
            return undefined;
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
        if (patch.status === 'active' && existing.status === 'paused') {
            await this.getGoalForResponse(sessionId, existing);
        }
        const updated = await withPreparedGoalResources(this.deps.dataDir, sessionId, patch.objectiveResources, (objectiveResources) => this.deps.store().patchByUser(existing.goalId, withUserStatusReason({
            ...patch,
            ...(objectiveResources !== undefined
                ? {
                    objectiveResources,
                    rejectIfUpdatedAtChangedFrom: patch.rejectIfUpdatedAtChangedFrom ?? existing.updatedAt,
                }
                : {}),
        })));
        this.deps.runtime.emitStateTransition(existing.status, updated);
        const shouldProjectRunningTime = patch.status === 'paused' || patch.status === 'active';
        const projected = shouldProjectRunningTime
            ? ((await this.getGoalForResponse(sessionId, updated)) ?? updated)
            : updated;
        this.deps.runtime.handleChanged({
            type: 'updated',
            goal: projected,
            userPatch: true,
            ...(projected.status === 'active' && existing.status !== 'active' && existing.statusReason
                ? { resumedFromReason: existing.statusReason }
                : {}),
            ...((patch.objective !== undefined && patch.objective !== existing.objective) ||
                JSON.stringify(updated.objectiveResources ?? []) !==
                    JSON.stringify(existing.objectiveResources ?? [])
                ? { objectiveChanged: true }
                : {}),
        });
        if (patch.status === 'paused') {
            await this.abortPausedThreadGoalTurn(sessionId);
        }
        return projected;
    }
    async updateTokenBudget(context, input) {
        const existing = await this.deps.store().getBySession(context.sessionId);
        if (!existing) {
            return { updated: false, error: 'cannot update goal because this thread has no goal' };
        }
        if (existing.goalId !== input.expectedGoalId ||
            existing.updatedAt !== input.expectedUpdatedAt) {
            return {
                updated: false,
                error: 'goal changed; call get_goal again before updating the token budget',
                currentGoal: existing,
            };
        }
        if (existing.status === 'complete') {
            return {
                updated: false,
                error: 'cannot update the token budget of a complete goal',
                currentGoal: existing,
            };
        }
        if (typeof input.tokenBudget === 'number' && input.tokenBudget <= existing.tokensUsed) {
            return {
                updated: false,
                error: `token_budget must be greater than the goal's ${existing.tokensUsed} accounted tokens`,
                currentGoal: existing,
            };
        }
        const resumed = existing.status === 'budget_limited';
        if (resumed && existing.statusReason !== 'budget_limited(token)') {
            return {
                updated: false,
                error: `cannot resume ${existing.statusReason ?? 'budget_limited'} by changing the token budget`,
                currentGoal: existing,
            };
        }
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
            if (error instanceof ThreadGoalEpochConflictError) {
                return {
                    updated: false,
                    error: 'goal changed; call get_goal again before updating the token budget',
                    ...(currentGoal ? { currentGoal } : {}),
                };
            }
            if (error instanceof ThreadGoalTokenBudgetExhaustedError) {
                return {
                    updated: false,
                    error: `token_budget must be greater than the goal's ${error.tokensUsed} accounted tokens`,
                    ...(currentGoal ? { currentGoal } : {}),
                };
            }
            if (error instanceof ThreadGoalBudgetLimitedError) {
                return {
                    updated: false,
                    error: 'cannot resume this budget-limited goal by changing the token budget',
                    ...(currentGoal ? { currentGoal } : {}),
                };
            }
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
    /** 只发布展示状态；不进入用户 PATCH 的执行和 continuation 链路。 */
    async dismissGoal(sessionId, goalId) {
        const dismissed = await this.deps.store().dismissCompleted(sessionId, goalId);
        publishThreadGoalEvent(this.deps.runtime.publishGlobalEvent, {
            type: 'updated',
            goal: dismissed,
        });
        return dismissed;
    }
    async deleteGoal(sessionId) {
        const existing = await this.deps.store().getBySession(sessionId);
        if (!existing)
            return false;
        await this.deps.continuation.cancelInitial(existing);
        await this.deps.store().delete(existing.goalId);
        this.deps.runtime.handleChanged({
            type: 'deleted',
            goalId: existing.goalId,
            sessionId,
            kickoffCancelled: true,
        });
        return true;
    }
    async pauseActiveGoalForAbort(sessionId) {
        await this.pauseActiveGoal(sessionId, 'paused(user_requested)', 'thread_goal_abort_pause_failed');
    }
    async pauseActiveGoalForRetraction(sessionId) {
        return this.pauseActiveGoal(sessionId, 'paused(retracted)', 'thread_goal_retraction_pause_failed');
    }
    async abortPausedThreadGoalTurn(sessionId) {
        const timing = this.deps.turnTimingReader.getBySession(sessionId);
        if (timing?.source !== 'thread-goal' || !this.deps.abortThreadGoalTurn)
            return;
        try {
            await this.deps.abortThreadGoalTurn(sessionId, timing.turnId);
        }
        catch (error) {
            this.deps.runtime.reportFailure(sessionId, `thread_goal_pause_abort_failed:${this.deps.runtime.formatError(error)}`);
        }
    }
    async runtimeToolsFor(disabled, _sessionId) {
        if (!this.deps.runtime.isEnabled() || disabled)
            return [];
        return buildThreadGoalRuntimeTools(this.deps.store(), false, this.deps.signalCollector, {
            updateTokenBudget: (context, input) => this.updateTokenBudget(context, input),
        });
    }
    tallyTurnUsage(messages) {
        return sumPiTurnUsageTokens(messages);
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
    recoverInitialContinuation(goal) {
        return this.deps.continuation.reconcileInitial(goal, false).then(() => undefined);
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
/**
 * Derive the user-authored status reason a bare status patch implies.
 *
 * This lives in the domain rather than in the wire contract: a `PatchGoalReq`
 * carries no `status_reason` field, so a transport-layer translator that
 * invents one is writing domain state it does not own — and that invented
 * field is exactly what silently diverted user pauses away from
 * `pauseGoalByUser`. An explicit reason from an internal caller still wins.
 */
/**
 * True when a patch would put the Goal back to work or change what it aims at:
 * reactivation, a new objective (with or without replacement resources), or a
 * new token budget. Pausing, completing, blocking, and clearing are excluded —
 * those are how a user gets out of a Goal, not into one.
 */
function restartsOrRetargetsGoal(patch) {
    return (patch.status === 'active' ||
        patch.objective !== undefined ||
        patch.objectiveResources !== undefined ||
        patch.tokenBudget !== undefined);
}
function withUserStatusReason(patch) {
    if (patch.statusReason !== undefined)
        return patch;
    if (patch.status === 'paused')
        return { ...patch, statusReason: 'paused(user_requested)' };
    if (patch.status === 'complete')
        return { ...patch, statusReason: 'complete(user_requested)' };
    return patch;
}
//# sourceMappingURL=lifecycle.js.map