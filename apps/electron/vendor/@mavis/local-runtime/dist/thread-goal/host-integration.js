import { composeGoalHostModules } from './composition.js';
import { emitThreadGoalRuntimeEvent, } from './events.js';
import { isThreadGoalEnabled } from './gate.js';
import { SqliteThreadGoalStore } from './store.js';
import { selectGoalReminderPromptKind } from './reminder-policy.js';
import { publishThreadGoalEvent } from './wiring.js';
/** Stable host facade; domain decisions live in the composed deep modules. */
export class LocalThreadGoalIntegration {
    deps;
    store;
    modules;
    configGetter;
    constructor(deps) {
        this.deps = deps;
        this.store = new SqliteThreadGoalStore(deps.dataDir, deps.nowMs);
        this.modules = composeGoalHostModules({
            deps,
            getStore: () => this.store,
            configGetter: () => (this.configGetter ?? deps.configGetter)?.() ?? {},
            isEnabled: () => this.isEnabled(),
            emitRuntimeEvent: (event) => this.emitRuntimeEvent(event),
            emitStateTransition: (from, goal) => this.emitStateTransition(from, goal),
            handleChanged: (event) => this.handleChanged(event),
            handleTurnTimingFinished: (timing) => this.handleTurnTimingFinished(timing),
        });
    }
    get orchestrator() {
        return this.modules.continuation.orchestrator;
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
    pauseGoalByUser(sessionId) {
        return this.modules.lifecycle.pauseGoalByUser(sessionId);
    }
    deleteGoal(sessionId) {
        return this.modules.lifecycle.deleteGoal(sessionId);
    }
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
    tallyTurnUsage(messages) {
        return this.modules.lifecycle.tallyTurnUsage(messages);
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
    checkTurnBudget(input) {
        return this.modules.admission.checkTurnBudget(input);
    }
    handleChanged(event) {
        this.modules.continuation.handleChanged(event);
    }
    recordTurnAccounting(sessionId, turnId, tokens) {
        return this.modules.settlement.recordTurnAccounting(sessionId, turnId, tokens);
    }
    settleInjectedTurn(input) {
        return this.modules.settlement.settleInjectedTurn(input);
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
    prepareRecoveryPrompt(goal) {
        const kind = selectGoalReminderPromptKind({ goal, recoveryPending: true }) ?? 'recovery';
        return this.preparePrompt(goal, kind).then((prompt) => ({ ...prompt, kind }));
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
//# sourceMappingURL=host-integration.js.map