/** Reads `{ enabled }` for a switch whose default the remote policy decides. */
export function parseExplicitEnabled(value) {
    const enabled = value != null && typeof value === 'object' && !Array.isArray(value)
        ? value.enabled
        : undefined;
    // Keep "never chose" distinct from an explicit `false`: the effective default
    // depends on the remote policy, which parsing cannot see.
    return typeof enabled === 'boolean' ? { enabled } : {};
}
/**
 * Accepts the Apollo object (`kill_switch`, `sample_rate`, `default_enabled`,
 * `next_step_default_enabled`).
 * Missing or invalid fields mean "no override", like the Runaway Guard
 * override: a malformed remote value never throws and never blocks the runtime
 * from starting.
 */
export function parsePromptSuggestionRemotePolicy(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        return {};
    const record = raw;
    const killSwitch = record.kill_switch ?? record.killSwitch;
    const sampleRate = record.sample_rate ?? record.sampleRate;
    const defaultEnabled = record.default_enabled ?? record.defaultEnabled;
    const nextStepDefaultEnabled = record.next_step_default_enabled ?? record.nextStepDefaultEnabled;
    return {
        ...(typeof killSwitch === 'boolean' ? { killSwitch } : {}),
        ...(typeof sampleRate === 'number' &&
            Number.isFinite(sampleRate) &&
            sampleRate >= 0 &&
            sampleRate <= 1
            ? { sampleRate }
            : {}),
        ...(typeof defaultEnabled === 'boolean' ? { defaultEnabled } : {}),
        ...(typeof nextStepDefaultEnabled === 'boolean' ? { nextStepDefaultEnabled } : {}),
    };
}
/**
 * The opt-in a Session actually runs with. An explicit user choice always
 * wins; otherwise the remote default decides, and the feature is on when no
 * remote default is configured. No build, account or model is special-cased.
 */
export function resolvePromptSuggestionEnabled(explicit, remote) {
    if (typeof explicit === 'boolean')
        return explicit;
    return remote?.defaultEnabled ?? true;
}
/** The Next Step card's effective opt-in, by the same rule as the suggestion. */
export function resolveNextStepBoxEnabled(explicit, remote) {
    if (typeof explicit === 'boolean')
        return explicit;
    return remote?.nextStepDefaultEnabled ?? true;
}
/**
 * Fills the effective opt-ins this policy decides (the next-message suggestion
 * and the Next Step card) into a config snapshot, so the runtime and the config
 * the UI reads see one value instead of each re-deriving it.
 */
export function withEffectivePromptSuggestion(config, remote) {
    const enabled = resolvePromptSuggestionEnabled(config.promptSuggestion?.enabled, remote);
    const nextStepEnabled = resolveNextStepBoxEnabled(config.nextStepBox?.enabled, remote);
    return {
        ...config,
        promptSuggestion: { ...config.promptSuggestion, enabled },
        nextStepBox: { ...config.nextStepBox, enabled: nextStepEnabled },
    };
}
//# sourceMappingURL=prompt-suggestion-config.js.map