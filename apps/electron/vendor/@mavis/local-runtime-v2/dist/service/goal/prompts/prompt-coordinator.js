import { renderVerificationInterruptedNotice, } from '@mavis/goal';
import { goalReminderReasons, goalTurnCount, selectGoalReminderPromptKind, } from './reminder-policy.js';
/** Owns transient prompt markers and their reminder observation lifecycle. */
export class GoalPromptCoordinator {
    deps;
    pendingObjectiveUpdates = new Set();
    pendingRecoveryGoals = new Set();
    interruptedVerifications = new Map();
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
    /**
     * The Goal was resumed after its verification ended without a verdict; its
     * next working Goal Turn carries the notice once (spec §14).
     */
    armVerificationInterrupted(goalId, reason) {
        this.interruptedVerifications.set(goalId, reason);
    }
    /** The one-shot notice for the Goal's next working Turn, if one is armed. */
    verificationInterruptedNotice(goalId) {
        const reason = this.interruptedVerifications.get(goalId);
        return reason ? renderVerificationInterruptedNotice(reason) : undefined;
    }
    clear(goalId) {
        this.pendingObjectiveUpdates.delete(goalId);
        this.pendingRecoveryGoals.delete(goalId);
        this.interruptedVerifications.delete(goalId);
        this.deliveredAuditTurns.delete(goalId);
    }
    selectOverride(goal) {
        if (this.pendingObjectiveUpdates.has(goal.goalId))
            return 'objective-updated';
        return selectGoalReminderPromptKind({
            goal,
            recoveryPending: this.pendingRecoveryGoals.has(goal.goalId),
            auditAlreadyDelivered: this.deliveredAuditTurns.get(goal.goalId) === goalTurnCount(goal),
        });
    }
    recordSubmitted(goal, kind) {
        this.interruptedVerifications.delete(goal.goalId);
        if (kind === 'objective-updated')
            this.clearObjectiveUpdate(goal.goalId);
        if (kind === 'recovery' || kind === 'recovery-terminal-audit') {
            this.clearRecovery(goal.goalId);
        }
        if (!isGoalReminderPromptKind(kind))
            return;
        const reasons = goalReminderReasons(kind);
        if (reasons.includes('terminal-audit')) {
            this.deliveredAuditTurns.set(goal.goalId, goalTurnCount(goal));
        }
        this.deps.emitRuntimeEvent({
            type: 'goal.reminder_injected',
            at: this.deps.nowMs(),
            payload: {
                goalId: goal.goalId,
                sessionId: goal.sessionId,
                turnsUsed: goalTurnCount(goal),
                reasons: [...reasons],
            },
        });
    }
}
function isGoalReminderPromptKind(kind) {
    return kind === 'recovery' || kind === 'terminal-audit' || kind === 'recovery-terminal-audit';
}
//# sourceMappingURL=prompt-coordinator.js.map