export function parsePluginsConfig(raw) {
    if (raw === undefined)
        return { forbidden: [] };
    if (raw === null ||
        typeof raw !== 'object' ||
        Array.isArray(raw) ||
        (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null)) {
        throw new Error('Invalid plugins config: expected an object.');
    }
    const { forbidden } = raw;
    if (forbidden === undefined)
        return { forbidden: [] };
    if (!Array.isArray(forbidden)) {
        throw new Error('Invalid plugins.forbidden config: expected an array of plugin names.');
    }
    const names = new Set();
    for (const [index, name] of forbidden.entries()) {
        if (typeof name !== 'string' || name.trim() === '') {
            throw new Error(`Invalid plugins.forbidden[${index}]: expected a non-empty plugin name string.`);
        }
        names.add(name.trim().normalize('NFKC').toLocaleLowerCase('en-US'));
    }
    return { forbidden: [...names] };
}
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