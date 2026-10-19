import { goalReminderReasons, selectGoalReminderPromptKind, } from './reminder-policy.js';
/** Owns transient prompt markers and their reminder observation lifecycle. */
export class GoalPromptCoordinator {
    deps;
    pendingObjectiveUpdates = new Set();
    pendingRecoveryGoals = new Set();
    deliveredAuditTurns = new Map();
    constructor(deps) {
        this.deps = deps;
    }
    armObjectiveUpdate(goalId) {
        this.pendingObjectiveUpdates.add(goalId);
    }
    clearObjectiveUpdate(goalId) {
        this.pendingObjectiveUpdates.delete(goalId);
    }
    armRecovery(goalId) {
        this.pendingRecoveryGoals.add(goalId);
    }
    clearRecovery(goalId) {
        this.pendingRecoveryGoals.delete(goalId);
    }
    clear(goalId) {
        this.pendingObjectiveUpdates.delete(goalId);
        this.pendingRecoveryGoals.delete(goalId);
        this.deliveredAuditTurns.delete(goalId);
    }
    selectOverride(goal) {
        if (this.pendingObjectiveUpdates.has(goal.goalId))
            return 'objective-updated';
        return selectGoalReminderPromptKind({
            goal,
            recoveryPending: this.pendingRecoveryGoals.has(goal.goalId),
            auditAlreadyDelivered: this.deliveredAuditTurns.get(goal.goalId) === goal.turnsUsed,
        });
    }
    recordSubmitted(goal, kind) {
        if (kind === 'objective-updated')
            this.clearObjectiveUpdate(goal.goalId);
        if (kind === 'recovery' || kind === 'recovery-terminal-audit') {
            this.clearRecovery(goal.goalId);
        }
        if (!isGoalReminderPromptKind(kind))
            return;
        const reasons = goalReminderReasons(kind);
        if (reasons.includes('terminal-audit')) {
            this.deliveredAuditTurns.set(goal.goalId, goal.turnsUsed);
        }
        this.deps.emitRuntimeEvent({
            type: 'goal.reminder_injected',
            at: this.deps.nowMs(),
            payload: {
                goalId: goal.goalId,
                sessionId: goal.sessionId,
                turnsUsed: goal.turnsUsed,
                reasons: [...reasons],
            },
        });
    }
}
function isGoalReminderPromptKind(kind) {
    return kind === 'recovery' || kind === 'terminal-audit' || kind === 'recovery-terminal-audit';
}
//# sourceMappingURL=prompt-coordinator.js.map