/**
 * The three Agent surface / dispatch switches of `x-mavis`. They live only in
 * the Agent's canonical `agent.md`; each is optional and defaults to true.
 *
 * Kept out of canonical-agent-config.ts so that codec stays inside the service
 * line budget, and so the runtime reader and the file codec agree on one field
 * list instead of repeating it.
 */
export const AGENT_SURFACE_SWITCH_FIELDS = [
    'showInImBinding',
    'showInAgentList',
    'dispatchable',
];
/**
 * Reads the declared switches out of an `x-mavis` mapping. A non-boolean value
 * is a configuration error, reported through the caller's `invalid` factory so
 * this module owns no error type of its own.
 */
export function parseAgentSurfaceSwitches(source, invalid) {
    const result = {};
    for (const field of AGENT_SURFACE_SWITCH_FIELDS) {
        const value = source[field];
        if (value === undefined)
            continue;
        if (typeof value !== 'boolean') {
            throw invalid(`x-mavis.${field}`, `${field} must be a boolean.`);
        }
        result[field] = value;
    }
    return result;
}
/** Writes back only the switches the Agent actually declared. */
export function serializeAgentSurfaceSwitches(value) {
    const result = {};
    for (const field of AGENT_SURFACE_SWITCH_FIELDS) {
        const declared = value[field];
        if (declared !== undefined)
            result[field] = declared;
    }
    return result;
}
//# sourceMappingURL=agent-surface-switches.js.map