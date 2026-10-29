/**
 * Accepts the Apollo object (`kill_switch`, `sample_rate`). Missing or invalid
 * fields mean "no override", like the Runaway Guard override: a malformed
 * remote value never throws and never blocks the runtime from starting.
 */
export function parsePromptSuggestionRemotePolicy(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        return {};
    const record = raw;
    const killSwitch = record.kill_switch ?? record.killSwitch;
    const sampleRate = record.sample_rate ?? record.sampleRate;
    return {
        ...(typeof killSwitch === 'boolean' ? { killSwitch } : {}),
        ...(typeof sampleRate === 'number' &&
            Number.isFinite(sampleRate) &&
            sampleRate >= 0 &&
            sampleRate <= 1
            ? { sampleRate }
            : {}),
    };
}
//# sourceMappingURL=prompt-suggestion-config.js.map