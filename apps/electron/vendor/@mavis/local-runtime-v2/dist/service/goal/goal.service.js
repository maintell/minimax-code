import { digestThreadGoalObjective } from '@mavis/goal';
import { composeGoalHostModules } from './composition.js';
import { emitThreadGoalRuntimeEvent, } from './observability/events.js';
import { isThreadGoalEnabled } from './lifecycle/gate.js';
import { selectGoalReminderPromptKind } from './prompts/reminder-policy.js';
import { publishThreadGoalEvent } from './observability/wiring.js';
/** The single Goal owner; domain decisions live in the composed deep modules. */
export class GoalService {
    deps;
    store;
    modules;
    configGetter;
    constructor(deps, store) {
        this.deps = deps;
        this.store = store;
        this.modules = composeGoalHostModules({
            deps,
            getStore: () => this.store,
            configGetter: () => (this.configGetter ?? deps.configGetter)?.() ?? {},
            isEnabled: () => this.isEnabled(),
            emitRuntimeEvent: (event) => this.emitRuntimeEvent(event),
            emitStateTransition: (from, goal) => this.emitStateTransition(from, goal),
            handleChanged: (event) => this.handleChanged(event),
            applyChange: (event) => this.applyChange(event),
            handleTurnTimingFinished: (timing) => this.handleTurnTimingFinished(timing),
        });
    }
    bindConfigGetter(configGetter) {
        this.configGetter = configGetter;
    }
    bindVerifier(verifier, transcriptWindowReader) {
        this.modules.settlement.bindVerifier(verifier, transcriptWindowReader);
    }
    recordVerifierChildStarted(input) {
        this.emitRuntimeEvent({
            type: 'goal.verification_child_started',
            at: this.deps.nowMs(),
            payload: {
                goalId: input.attempt.goalId,
                sessionId: input.attempt.sessionId,
                turnId: input.attempt.turnId,
                backend: 'subagent',
                childSessionId: input.traceRef.sessionId,
                ...(input.traceRef.turnId ? { childTurnId: input.traceRef.turnId } : {}),
            },
        });
    }
    isEnabled() {
        return (this.deps.isEnabled?.() ?? isThreadGoalEnabled(this.configGetter ?? this.deps.configGetter));
    }
    createGoal(input, options = {}) {
        return this.modules.lifecycle.createGoal(input, options);
    }
    patchGoal(sessionId, patch) {
        return this.modules.lifecycle.patchGoal(sessionId, patch);
    }
    /** `patchGoal`, plus what a resume led to when the patch was one (spec §6). */
    patchGoalWithOutcome(sessionId, patch) {
        return this.modules.lifecycle.patchGoalWithOutcome(sessionId, patch);
    }
    pauseGoalByUser(sessionId) {
        return this.modules.lifecycle.pauseGoalByUser(sessionId);
    }
    deleteGoal(sessionId) {
        return this.modules.lifecycle.deleteGoal(sessionId);
    }
    /**
     * 内容安审撤回了目标的第一轮。按 `deleteGoal` 的方式删除目标，但只在它仍是这一轮
     * 发起的目标、描述也没变时才删；被替换或改过的目标不动。被撤回的这一轮本身不中止：
     * 它已经在结束了。
     */
    async deleteGoalAfterKickoffRecall(input) {
        const deleted = await this.modules.lifecycle.deleteGoalIf(input.sessionId, (goal) => goal.goalId === input.goalId &&
            digestThreadGoalObjective(goal.objective) === input.objectiveDigest, input.turnId);
        if (!deleted)
            return undefined;
        return typeof deleted.tokenBudget === 'number'
            ? { goalId: deleted.goalId, tokenBudget: deleted.tokenBudget }
            : { goalId: deleted.goalId };
    }
    /** The running Goal Turn that pausing or clearing this Session's Goal stops. */
    runningGoalTurnId(sessionId) {
        return this.modules.lifecycle.runningGoalTurnId(sessionId);
    }
    /** Hide a completed Goal's notice on every client; never changes execution. */
    dismissGoal(sessionId, goalId) {
        return this.modules.lifecycle.dismissGoal(sessionId, goalId);
    }
    pauseActiveGoalForAbort(sessionId) {
        return this.modules.lifecycle.pauseActiveGoalForAbort(sessionId);
    }
    pauseActiveGoalForRetraction(sessionId) {
        return this.modules.lifecycle.pauseActiveGoalForRetraction(sessionId);
    }
    runtimeToolsFor(disabled, sessionId) {
        return this.modules.lifecycle.runtimeToolsFor(disabled, sessionId);
    }
    getGoalForResponse(sessionId, persistedState) {
        return this.modules.lifecycle.getGoalForResponse(sessionId, persistedState);
    }
    handleTurnTimingFinished(timing) {
        this.modules.lifecycle.handleTurnTimingFinished(timing);
    }
    handleCreated(goal) {
        return this.modules.lifecycle.handleCreated(goal);
    }
    recoverInitialContinuation(goal) {
        return this.modules.lifecycle.recoverInitialContinuation(goal);
    }
    classifyQueuedItem(item, hasPendingPlan) {
        return this.modules.admission.classifyQueuedItem(item, hasPendingPlan);
    }
    prepareTurnAdmission(input) {
        return this.isEnabled()
            ? this.modules.admission.prepareTurnAdmission(input)
            : Promise.resolve(undefined);
    }
    getTurnBinding(turnId) {
        return this.modules.turnContext.getBinding(turnId)?.binding;
    }
    /** The Goal this Session's Turn is bound to until it settles; undefined for any other Turn. */
    goalIdForTurn(sessionId, turnId) {
        return this.modules.turnContext.goalIdForTurn(sessionId, turnId);
    }
    /** Whether the user's deletion detached this Turn from its Goal; answered once, at its end. */
    takeDetachedTurn(sessionId, turnId) {
        return this.modules.turnContext.takeDetached(sessionId, turnId);
    }
    /** The durable request barrier of a bound Goal main-execution Turn; undefined for any other Turn. */
    requestLifecycleFor(turn) {
        return this.isEnabled() ? this.modules.accounting.lifecycleFor(turn) : undefined;
    }
    /**
     * The counting-only recorder of a Turn whose requests a Goal is charged for
     * outside the request ledger: a sub-session round a Goal Turn started, or a
     * Goal Turn's automatic compaction. Undefined for every other Turn.
     */
    usageRecorderFor(turn) {
        return this.modules.tokenCharging.usageRecorderFor(turn);
    }
    /** A Turn asked for a round in another Session; see `GoalTokenCharging.attributeRound`. */
    attributeSubSessionRound(input) {
        return this.modules.tokenCharging.attributeRound(input);
    }
    forgetSubSessionRound(childTurnId) {
        this.modules.tokenCharging.forgetRound(childTurnId);
    }
    /** The queue runs a requested round under a fresh Turn id; see `GoalTokenCharging.transferRound`. */
    transferSubSessionRound(input) {
        this.modules.tokenCharging.transferRound(input);
    }
    /** True once a bound Goal Turn may send neither a work nor a wrap-up request. */
    shouldStopAfterStep(turn) {
        return this.modules.accounting.shouldStopAfterStep(turn);
    }
    /** True once a bound Goal Turn may send no further work request (only wrap-up, or nothing). */
    isWorkClosed(turn) {
        return this.modules.accounting.isWorkClosed(turn);
    }
    /**
     * Startup recovery of requests the previous process left open: never-sent
     * reservations are released, possibly-sent requests stay as unknown
     * occupancy and are never re-sent.
     */
    async recoverInterruptedRequests() {
        await this.store.recoverInterruptedRequests();
    }
    checkTurnBudget(input) {
        return this.modules.admission.checkTurnBudget(input);
    }
    handleChanged(event) {
        this.syncUsageRecovery(event);
        this.modules.continuation.handleChanged(event);
    }
    applyChange(event) {
        this.syncUsageRecovery(event);
        return this.modules.continuation.applyChange(event);
    }
    /**
     * Reconcile the recovery timer against every observed change, so a Goal that
     * stops being quota-parked (resumed, paused, cleared, replaced, completed)
     * loses its timer at the same moment its row does.
     */
    syncUsageRecovery(event) {
        if (event.type === 'deleted') {
            this.modules.usageRecovery.cancel(event.goalId);
        }
        else {
            this.modules.usageRecovery.sync(event.goal);
        }
    }
    /**
     * Re-arm automatic account-quota recovery from the durable rows.
     *
     * Called once during startup recovery. A recovery time that elapsed while
     * this process was not running resumes its Goal immediately instead of being
     * lost, which is the whole point of keeping the schedule on the row.
     */
    recoverUsageLimitedGoals() {
        if (!this.isEnabled())
            return Promise.resolve(0);
        return this.modules.usageRecovery.recoverFromStore();
    }
    /** Release recovery timers; the durable rows keep the schedule. */
    stopUsageRecovery() {
        this.modules.usageRecovery.stop();
    }
    /** Record a bound Turn's active time; its tokens were charged per request by the ledger. */
    recordTurnAccounting(sessionId, turnId) {
        return this.modules.settlement.recordTurnAccounting(sessionId, turnId);
    }
    settleInjectedTurn(input) {
        return this.modules.settlement.settleInjectedTurn(input);
    }
    /** An ordinary Turn finally failed; keep the active Goal going (spec §6). */
    continueAfterOrdinaryTurnFailure(turn) {
        return this.modules.lifecycle.continueAfterOrdinaryTurnFailure(turn);
    }
    rebindInternalPromptRead(input, turnId) {
        this.deps.internalTurnPromptReads?.()?.rebind(input.requestedTurnId, turnId);
    }
    discardInternalPromptRead(input) {
        this.deps.internalTurnPromptReads?.()?.discard(input.requestedTurnId);
    }
    shouldRecoverActiveContinuation(goal) {
        return this.modules.continuation.shouldRecoverActive(goal);
    }
    injectObjectiveUpdatedSteering(goal) {
        return this.modules.continuation.injectObjectiveUpdatedSteering(goal);
    }
    preparePrompt(goal, kind) {
        return this.modules.continuation.preparePrompt(goal, kind);
    }
    async prepareRecoveryPrompt(goal) {
        const kind = selectGoalReminderPromptKind({ goal, recoveryPending: true }) ?? 'recovery';
        return { ...(await this.preparePrompt(goal, kind)), kind };
    }
    recordPromptSubmitted(goal, kind) {
        this.modules.continuation.recordPromptSubmitted(goal, kind);
    }
    emitStateTransition(from, goal) {
        if (goal.status === from || goal.statusReason === null)
            return;
        this.emitRuntimeEvent({
            type: 'goal.state_transitioned',
            at: this.deps.nowMs(),
            payload: {
                goalId: goal.goalId,
                sessionId: goal.sessionId,
                from,
                to: goal.status,
                reason: goal.statusReason,
            },
        });
    }
    emitRuntimeEvent(event) {
        emitThreadGoalRuntimeEvent(event, this.deps.emitRuntimeEvent);
    }
    /**
     * Retire `verification` waits left behind by a previous process.
     *
     * Verification runs entirely in memory, so no dispatch can outlive a
     * restart: every such wait found here is stale by construction. Clearing is
     * epoch-guarded and never advances `updatedAt`, so it publishes the corrected
     * projection without touching the Turn admission decision epoch. Returns the
     * number of Goals actually corrected.
     */
    async clearStaleVerificationWaits() {
        const stale = await this.store.listGoalsWaitingOnVerification();
        let cleared = 0;
        for (const goal of stale) {
            const updated = await this.store.clearExecutionWaitAtEpoch({
                goalId: goal.goalId,
                expectedUpdatedAt: goal.updatedAt,
            });
            if (!updated)
                continue;
            cleared += 1;
            publishThreadGoalEvent(this.deps.publishGlobalEvent, { type: 'updated', goal: updated });
        }
        return cleared;
    }
}
//# sourceMappingURL=goal.service.js.map