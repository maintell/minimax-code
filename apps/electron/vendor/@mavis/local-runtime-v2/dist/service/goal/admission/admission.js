import { digestThreadGoalObjective, isContinuationStatus, } from '@mavis/goal';
import { checkThreadGoalTurnBudget } from './admission-budget.js';
import { classifyThreadGoalQueueItem } from './admission-queue.js';
import { finalRecheck, } from '../lifecycle/gate.js';
import { readThreadGoalContinuationOrigin, readThreadGoalKickoffOrigin, } from '../continuation/kickoff.js';
import { publishThreadGoalEvent } from '../observability/wiring.js';
/** Owns queue classification, final admission, immutable turn binding, and live budget fences. */
export class GoalAdmission {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    classifyQueuedItem(item, hasPendingPlan) {
        return classifyThreadGoalQueueItem(item, hasPendingPlan, {
            getGoalBySession: (sessionId) => this.deps.store().getBySession(sessionId),
            gates: this.deps.gates,
            failures: this.deps.failures,
            emitDecision: (sessionId, goalId, decision, reason) => this.emitAdmissionDecision({
                sessionId,
                goalId,
                decision,
                phase: 'queue_selection',
                reason,
            }),
            emitQueueItemDeferred: (sessionId, reason) => this.deps.events.emitRuntimeEvent({
                type: 'goal.queue_item_deferred',
                at: this.deps.events.nowMs(),
                payload: { sessionId, reason },
            }),
            projectExecutionWait: (goal, reason) => this.projectExecutionWait(goal, reason),
        });
    }
    async prepareTurnAdmission(input) {
        if (input.provenance.source !== 'thread-goal')
            return this.prepareNonGoalTurnAdmission(input);
        const origin = input.provenance.sourceContext?.origin;
        const continuation = readThreadGoalContinuationOrigin(origin);
        const expected = readThreadGoalKickoffOrigin(origin) ?? continuation;
        if (!expected)
            return rejectedAdmission('cancel', 'stale(turn_binding)');
        // A pre-upgrade budget-summary item never starts a Turn: budgets wrap up
        // inside the Goal Turn that reaches them.
        if (continuation?.kind === 'budget-limit') {
            return rejectedAdmission('cancel', 'stale(turn_binding)');
        }
        let result;
        try {
            result = await this.runFinalRecheck(input, expected);
        }
        catch (error) {
            return this.deferUnreadableGate(input, expected, error);
        }
        if (result.decision === 'ready')
            return this.readyTurnBindingPreparation(input, result.binding);
        return this.rejectAfterFinalRecheck(input, expected, result);
    }
    /** Ordinary user work resets the breaker; a Goal questionnaire reply rebinds the Goal. */
    prepareNonGoalTurnAdmission(input) {
        const owner = input.userInputResume?.owner;
        if (input.provenance.source === 'questionnaire' && owner?.kind === 'thread-goal') {
            return this.prepareGoalQuestionnaireResume(input, owner.goalId);
        }
        return isExplicitUserTurnSource(input.provenance.source)
            ? this.deps.prepareExplicitUserBreakerReset({
                sessionId: input.sessionId,
                turnId: input.turnId,
            })
            : undefined;
    }
    runFinalRecheck(input, expected) {
        return finalRecheck({
            getGoalBySession: (sessionId) => this.deps.store().getBySession(sessionId),
            hasPendingQuestionnaire: (sessionId, goalId) => this.deps.gates.hasPendingQuestionnaire(sessionId, goalId),
            hasPendingPermission: (sessionId) => this.deps.gates.hasPendingPermission(sessionId),
            hasPendingPlan: input.hasPendingPlan,
            hasRequiredBackgroundWork: (sessionId, goalId) => this.deps.gates.hasRequiredBackgroundWork(sessionId, goalId),
            hasAutomationOwnerConflict: (sessionId) => this.deps.gates.hasAutomationOwnerConflict(sessionId),
            hasPriorityMailboxWork: input.hasPriorityMailboxWork,
        }, {
            sessionId: input.sessionId,
            goalId: expected.goalId,
            expectedUpdatedAt: expected.goalUpdatedAt,
            expectedObjectiveDigest: expected.objectiveDigest,
            turnId: input.turnId,
        }, this.deps.configGetter);
    }
    /**
     * A gate that cannot be read is still a blocker, and one the user can
     * neither see nor act on unless we say so.
     */
    async deferUnreadableGate(input, expected, error) {
        this.deps.failures.report(input.sessionId, `thread_goal_final_recheck_failed:${this.deps.failures.format(error)}`);
        await this.projectExecutionWait({
            goalId: expected.goalId,
            sessionId: input.sessionId,
            updatedAt: expected.goalUpdatedAt,
        }, 'dependency_unavailable');
        this.emitAdmissionDecision({
            sessionId: input.sessionId,
            goalId: expected.goalId,
            decision: 'deferred',
            phase: 'final_recheck',
            reason: 'deferred(dependency_unavailable)',
        });
        return {
            status: 'rejected',
            reason: 'policy:goal-final-recheck:deferred(final_recheck_unavailable)',
            queueDisposition: 'defer',
        };
    }
    async rejectAfterFinalRecheck(input, expected, result) {
        if (result.decision === 'pause' && result.goal) {
            await this.stopAtFinalRecheck(result.goal, result.reason);
        }
        this.emitAdmissionDecision({
            sessionId: input.sessionId,
            goalId: expected.goalId,
            decision: result.decision === 'defer' ? 'deferred' : 'cancelled',
            phase: 'final_recheck',
            reason: result.reason,
        });
        if ('waitReason' in result && result.waitReason && result.goal) {
            await this.projectExecutionWait(result.goal, result.waitReason);
        }
        else if (result.decision === 'cancel' && result.goal) {
            await this.clearExecutionWait(input.sessionId, expected.goalId, expected.goalUpdatedAt);
        }
        return rejectedAdmission(result.decision === 'defer' ? 'defer' : 'cancel', result.reason);
    }
    async stopAtFinalRecheck(goal, reason) {
        const transitioned = await this.deps
            .store()
            .transitionActiveAtEpoch(goal.goalId, goal.updatedAt, {
            status: 'budget_limited',
            statusReason: reason,
        });
        if (!transitioned)
            return;
        this.deps.events.emitStateTransition(goal.status, transitioned);
        publishThreadGoalEvent(this.deps.events.publishGlobalEvent, {
            type: 'updated',
            goal: transitioned,
        });
    }
    /**
     * Live budget fence used immediately before a v2 tool call. Each exhausted
     * check consumes at most one configured grace step before returning `stop`.
     */
    async checkTurnBudget(input) {
        return checkThreadGoalTurnBudget(input, this.deps);
    }
    async prepareGoalQuestionnaireResume(input, expectedGoalId) {
        let goal;
        try {
            goal = await this.deps.store().getBySession(input.sessionId);
        }
        catch (error) {
            this.deps.failures.report(input.sessionId, `thread_goal_questionnaire_resume_read_failed:${this.deps.failures.format(error)}`);
            return rejectedAdmission('defer', 'deferred(goal_not_active)');
        }
        if (!goal || goal.goalId !== expectedGoalId) {
            this.emitAdmissionDecision({
                sessionId: input.sessionId,
                goalId: expectedGoalId,
                decision: 'cancelled',
                phase: 'final_recheck',
                reason: 'stale(turn_binding)',
            });
            return rejectedAdmission('cancel', 'stale(turn_binding)');
        }
        if (!isContinuationStatus(goal.status)) {
            this.emitAdmissionDecision({
                sessionId: input.sessionId,
                goalId: goal.goalId,
                decision: 'deferred',
                phase: 'final_recheck',
                reason: 'deferred(goal_not_active)',
            });
            return rejectedAdmission('defer', 'deferred(goal_not_active)');
        }
        return this.readyTurnBindingPreparation(input, {
            goalId: goal.goalId,
            admittedGoalUpdatedAt: goal.updatedAt,
            objectiveDigest: digestThreadGoalObjective(goal.objective),
            turnId: input.turnId,
        });
    }
    readyTurnBindingPreparation(input, binding) {
        this.emitAdmissionDecision({
            sessionId: input.sessionId,
            goalId: binding.goalId,
            decision: 'ready',
            phase: 'final_recheck',
        });
        return {
            status: 'ready',
            commit: async () => {
                this.deps.turnContext.setBinding(input.turnId, {
                    sessionId: input.sessionId,
                    binding,
                    kind: 'main',
                    mainTurns: 1,
                    graceStepsUsed: 0,
                });
                this.deps.turnHistory.record(binding.goalId, input.turnId);
                // The Turn is now bound, so whatever the Goal was waiting on is no
                // longer true. Clearing here (rather than on the `ready` verdict) keeps
                // the wait visible for the whole window in which admission could still
                // reject.
                await this.clearExecutionWait(input.sessionId, binding.goalId, binding.admittedGoalUpdatedAt);
                this.deps.events.emitRuntimeEvent({
                    type: 'goal.turn_bound',
                    at: this.deps.events.nowMs(),
                    payload: {
                        goalId: binding.goalId,
                        sessionId: input.sessionId,
                        turnId: input.turnId,
                        goalUpdatedAt: binding.admittedGoalUpdatedAt,
                    },
                });
            },
            rollback: async () => this.deps.turnContext.deleteBinding(input.turnId),
            compensate: async () => this.deps.turnContext.deleteBinding(input.turnId),
        };
    }
    emitAdmissionDecision({ sessionId, goalId, decision, phase, reason, }) {
        this.deps.events.emitRuntimeEvent({
            type: 'goal.admission_decided',
            at: this.deps.events.nowMs(),
            payload: { goalId, sessionId, phase, decision, ...(reason ? { reason } : {}) },
        });
    }
    /**
     * Publish "this Goal is parked on <reason>" without disturbing admission.
     *
     * The store no-ops when the reason is unchanged or the epoch has moved on, so
     * repeated drains neither reset the user-visible wait timer nor emit
     * redundant events.
     */
    async projectExecutionWait(goal, reason) {
        await this.publishExecutionWaitChange(goal.sessionId, () => this.deps.store().setExecutionWaitAtEpoch({
            goalId: goal.goalId,
            expectedUpdatedAt: goal.updatedAt,
            reason,
        }));
    }
    async clearExecutionWait(sessionId, goalId, expectedUpdatedAt) {
        await this.publishExecutionWaitChange(sessionId, () => this.deps.store().clearExecutionWaitAtEpoch({ goalId, expectedUpdatedAt }));
    }
    async publishExecutionWaitChange(sessionId, write) {
        try {
            const updated = await write();
            if (!updated)
                return;
            publishThreadGoalEvent(this.deps.events.publishGlobalEvent, {
                type: 'updated',
                goal: updated,
            });
        }
        catch (error) {
            // The wait projection is an explanation, not a gate. Losing it degrades
            // the UI to today's behaviour; letting it throw would break dispatch.
            this.deps.failures.report(sessionId, `thread_goal_execution_wait_projection_failed:${this.deps.failures.format(error)}`);
        }
    }
}
function rejectedAdmission(queueDisposition, reason) {
    return {
        status: 'rejected',
        reason: `policy:goal-final-recheck:${reason}`,
        queueDisposition,
    };
}
function isExplicitUserTurnSource(source) {
    return (source === 'api' ||
        source === 'questionnaire' ||
        source === 'communication' ||
        source === 'code_review' ||
        source.startsWith('channel:'));
}
//# sourceMappingURL=admission.js.map