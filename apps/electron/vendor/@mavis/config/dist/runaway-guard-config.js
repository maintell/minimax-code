/** Missing/invalid remote values mean no override, not enabled=true. */
export function parseRunawayGuardOverride(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        return {};
    const enabled = raw.enabled;
    return typeof enabled === 'boolean' ? { enabled } : {};
}
export function resolveRunawayGuardConfig(local, remote) {
    return {
        enabled: parseRunawayGuardOverride(remote).enabled ?? parseRunawayGuardOverride(local).enabled ?? true,
        bunnyRoundBudgetBlock: readLocalBoolean(local, 'bunnyRoundBudgetBlock') ?? false,
    };
}
function readLocalBoolean(raw, key) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        return undefined;
    const value = raw[key];
    return typeof value === 'boolean' ? value : undefined;
}
//# sourceMappingURL=runaway-guard-config.js.map