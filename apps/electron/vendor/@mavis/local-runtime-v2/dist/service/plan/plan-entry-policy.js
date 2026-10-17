export function resolvePlanEntryPolicy(beta) {
    const manualEntryEnabled = beta?.desktopPlanMode !== false;
    return {
        manualEntryEnabled,
        agentEntryEnabled: manualEntryEnabled && beta?.desktopPlanModeAgentEntry === true,
    };
}
export function createPlanEntryReaders(config) {
    return {
        planEntryEnabled: () => resolvePlanEntryPolicy(config().beta).manualEntryEnabled,
        agentPlanEntryEnabled: () => resolvePlanEntryPolicy(config().beta).agentEntryEnabled,
    };
}
//# sourceMappingURL=plan-entry-policy.js.map