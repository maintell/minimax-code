export const GOAL_TERMINAL_AUDIT_INTERVAL = 5;
export function selectGoalReminderPromptKind(input) {
    if (input.goal.status !== 'active')
        return undefined;
    const auditDue = input.auditAlreadyDelivered !== true &&
        input.goal.turnsUsed > 0 &&
        input.goal.turnsUsed % GOAL_TERMINAL_AUDIT_INTERVAL === 0;
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