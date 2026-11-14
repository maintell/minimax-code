import path from 'node:path';
/** Only absolute, non-empty fault file paths enable the tree; anything else is dropped. */
export function parseDiagnosticsConfig(raw) {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw))
        return undefined;
    const config = {};
    for (const key of ['steerFaultFile', 'turnFaultFile']) {
        const value = Reflect.get(raw, key);
        if (typeof value === 'string' && path.isAbsolute(value))
            config[key] = value;
    }
    return Object.keys(config).length ? config : undefined;
}
//# sourceMappingURL=diagnostics-config.js.map