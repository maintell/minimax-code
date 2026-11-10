/** @internal Exported only so focused tests can pin the audit cadence. */
export const GOAL_TERMINAL_AUDIT_INTERVAL = 5;
/**
 * Goal Turns so far. Local Goals count them from the request ledger, because
 * `turnsUsed` is frozen at the pre-upgrade value; other states keep it.
 */
export function goalTurnCount(goal) {
    return goal.accounting?.goalTurns ?? goal.turnsUsed;
}
export function selectGoalReminderPromptKind(input) {
    if (input.goal.status !== 'active')
        return undefined;
    const turns = goalTurnCount(input.goal);
    const auditDue = input.auditAlreadyDelivered !== true && turns > 0 && turns % GOAL_TERMINAL_AUDIT_INTERVAL === 0;
    if (input.recoveryPending && auditDue)
        return 'recovery-terminal-audit';
    if (input.recoveryPending)
        return 'recovery';
    if (auditDue)
        return 'terminal-audit';
    return undefined;
}
export function goalReminderReasons(kind) {
    if (kind === 'recovery-terminal-audit')
        return ['recovery', 'terminal-audit'];
    return [kind];
}
//# sourceMappingURL=reminder-policy.js.map