import { digestThreadGoalObjective, isContinuationStatus, } from '@mavis/goal';
import { checkThreadGoalTurnBudget } from './admission-budget.js';
import { classifyThreadGoalQueueItem } from './admission-queue.js';
import { finalRecheck, } from './gate.js';
import { readThreadGoalContinuationOrigin, readThreadGoalKickoffOrigin, } from './kickoff.js';
import { publishThreadGoalEvent } from './wiring.js';
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
            emitDecision: (sessionId, goalId, decision, reason) => this.emitAdmissionDecision(sessionId, goalId, decision, 'queue_selection', reason),
            emitQueueItemDeferred: (sessionId, reason) => this.deps.events.emitRuntimeEvent({
                type: 'goal.queue_item_deferred',
                at: this.deps.events.nowMs(),
                payload: { sessionId, reason },
            }),
            projectExecutionWait: (goal, reason) => this.projectExecutionWait(goal, reason),
        });
    }
    async prepareTurnAdmission(input) {
        if (input.provenance.source !== 'thread-goal') {
            if (input.provenance.source === 'questionnaire' &&
                input.userInputResume?.owner?.kind === 'thread-goal') {
                return this.prepareGoalQuestionnaireResume(input, input.userInputResume.owner.goalId);
            }
            return isExplicitUserTurnSource(input.provenance.source)
                ? this.deps.prepareExplicitUserBreakerReset({
                    sessionId: input.sessionId,
                    turnId: input.turnId,
                })
                : undefined;
        }
        const origin = input.provenance.sourceContext?.origin;
        const kickoff = readThreadGoalKickoffOrigin(origin);
        const continuation = readThreadGoalContinuationOrigin(origin);
        const expected = kickoff ?? continuation;
        if (!expected)
            return rejectedAdmission('cancel', 'stale(turn_binding)');
        let result;
        try {
            if (continuation?.kind === 'budget-limit') {
                const binding = await this.captureBudgetSummaryBinding(input, continuation);
                if (!binding) {
                    this.emitAdmissionDecision(input.sessionId, continuation.goalId, 'cancelled', 'final_recheck', 'stale(turn_binding)');
                    return rejectedAdmission('cancel', 'stale(turn_binding)');
                }
                return this.readyTurnBindingPreparation(input, binding, 'budget-summary');
            }
            result = await finalRecheck({
                getGoalBySession: (sessionId) => this.deps.store().getBySession(sessionId),
                hasPendingQuestionnaire: (sessionId, goalId) => this.deps.gates.hasPendingQuestionnaire(sessionId, goalId),
                hasPendingPermission: (sessionId) => this.deps.gates.hasPendingPermission(sessionId),
                hasPendingPlan: input.hasPendingPlan,
                hasRequiredBackgroundWork: (sessionId) => this.deps.gates.hasRequiredBackgroundWork(sessionId),
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
        catch (error) {
            this.deps.failures.report(input.sessionId, `thread_goal_final_recheck_failed:${this.deps.failures.format(error)}`);
            // A gate that cannot be read is still a blocker, and one the user can
            // neither see nor act on unless we say so.
            await this.projectExecutionWait({
                goalId: expected.goalId,
                sessionId: input.sessionId,
                updatedAt: expected.goalUpdatedAt,
            }, 'dependency_unavailable');
            this.emitAdmissionDecision(input.sessionId, expected.goalId, 'deferred', 'final_recheck', 'deferred(dependency_unavailable)');
            return {
                status: 'rejected',
                reason: 'policy:goal-final-recheck:deferred(final_recheck_unavailable)',
                queueDisposition: 'defer',
            };
        }
        if (result.decision === 'ready') {
            return this.readyTurnBindingPreparation(input, result.binding, 'main');
        }
        if (result.decision === 'pause' && result.goal) {
            const transitioned = await this.deps
                .store()
                .transitionActiveAtEpoch(result.goal.goalId, result.goal.updatedAt, {
                status: 'budget_limited',
                statusReason: result.reason,
            });
            if (transitioned) {
                this.deps.events.emitStateTransition(result.goal.status, transitioned);
                publishThreadGoalEvent(this.deps.events.publishGlobalEvent, {
                    type: 'updated',
                    goal: transitioned,
                });
            }
        }
        this.emitAdmissionDecision(input.sessionId, expected.goalId, result.decision === 'defer' ? 'deferred' : 'cancelled', 'final_recheck', result.reason);
        if ('waitReason' in result && result.waitReason && result.goal) {
            await this.projectExecutionWait(result.goal, result.waitReason);
        }
        else if (result.decision === 'cancel' && result.goal) {
            await this.clearExecutionWait(input.sessionId, expected.goalId, expected.goalUpdatedAt);
        }
        return rejectedAdmission(result.decision === 'defer' ? 'defer' : 'cancel', result.reason);
    }
    /**
     * Live budget fence used immediately before a v2 tool call. Each exhausted
     * check consumes at most one configured grace step before returning `stop`.
     */
    async checkTurnBudget(input) {
        return checkThreadGoalTurnBudget(input, this.deps);
    }
    async captureBudgetSummaryBinding(input, origin) {
        const goal = await this.deps.store().getBySession(input.sessionId);
        if (!goal ||
            goal.goalId !== origin.goalId ||
            goal.status !== 'budget_limited' ||
            goal.updatedAt !== origin.goalUpdatedAt ||
            digestThreadGoalObjective(goal.objective) !== origin.objectiveDigest) {
            return undefined;
        }
        return {
            goalId: goal.goalId,
            admittedGoalUpdatedAt: goal.updatedAt,
            objectiveDigest: origin.objectiveDigest,
            turnId: input.turnId,
        };
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
            this.emitAdmissionDecision(input.sessionId, expectedGoalId, 'cancelled', 'final_recheck', 'stale(turn_binding)');
            return rejectedAdmission('cancel', 'stale(turn_binding)');
        }
        if (!isContinuationStatus(goal.status)) {
            this.emitAdmissionDecision(input.sessionId, goal.goalId, 'deferred', 'final_recheck', 'deferred(goal_not_active)');
            return rejectedAdmission('defer', 'deferred(goal_not_active)');
        }
        return this.readyTurnBindingPreparation(input, {
            goalId: goal.goalId,
            admittedGoalUpdatedAt: goal.updatedAt,
            objectiveDigest: digestThreadGoalObjective(goal.objective),
            turnId: input.turnId,
        }, 'main');
    }
    readyTurnBindingPreparation(input, binding, kind) {
        this.emitAdmissionDecision(input.sessionId, binding.goalId, 'ready', 'final_recheck');
        return {
            status: 'ready',
            commit: async () => {
                this.deps.turnContext.setBinding(input.turnId, {
                    sessionId: input.sessionId,
                    binding,
                    kind,
                    mainTurns: kind === 'main' ? 1 : 0,
                    graceStepsUsed: 0,
                });
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
    emitAdmissionDecision(sessionId, goalId, decision, phase, reason) {
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