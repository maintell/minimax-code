export function parseStartupRecoveryFault(raw) {
    if (!raw || typeof raw !== 'object')
        return {};
    const step = Reflect.get(raw, 'step');
    const mode = Reflect.get(raw, 'mode');
    if (typeof step !== 'string' || (mode !== 'hang' && mode !== 'fail'))
        return {};
    return { startupRecoveryFault: { step, mode } };
}
export function parseNotificationsConfig(raw) {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw))
        return undefined;
    const obj = raw;
    return {
        branchFinish: typeof obj.branchFinish === 'boolean' ? obj.branchFinish : false,
    };
}
//# sourceMappingURL=config-section-parsers.js.map