export const SUBAGENT_CONFIG_DEFAULTS = {
    maxConcurrentPerSession: 4,
};
/**
 * Parses the Desktop Task-child concurrency setting. Admission re-reads it
 * from the current config on every check.
 *
 * Invalid values fall back to the safe default so config mistakes never
 * remove the execution bound.
 */
export function parseSubagentConfig(raw) {
    const config = raw != null && typeof raw === 'object' && !Array.isArray(raw)
        ? raw
        : {};
    const maxConcurrentPerSession = config.maxConcurrentPerSession;
    return {
        maxConcurrentPerSession: typeof maxConcurrentPerSession === 'number' &&
            Number.isSafeInteger(maxConcurrentPerSession) &&
            maxConcurrentPerSession > 0
            ? maxConcurrentPerSession
            : SUBAGENT_CONFIG_DEFAULTS.maxConcurrentPerSession,
    };
}
//# sourceMappingURL=subagent-config.js.map