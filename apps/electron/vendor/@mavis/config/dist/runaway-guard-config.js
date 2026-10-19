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
    };
}
//# sourceMappingURL=runaway-guard-config.js.map