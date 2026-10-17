const REASONS = new Set(['shutdown', 'close-app', 'critical', 'logoff']);
/** Shared by live probes, the persisted marker and historical outbox replay. */
export function readSystemSessionEndEvidence(value) {
    const phase = value.system_session_end_phase;
    const at = value.system_session_end_at;
    if ((phase !== 'query_received' && phase !== 'end_received') ||
        typeof at !== 'number' ||
        !Number.isSafeInteger(at) ||
        at < 0) {
        return undefined;
    }
    const reasons = value.system_session_end_reasons;
    return {
        system_session_end_phase: phase,
        system_session_end_at: at,
        system_session_end_reasons: Array.isArray(reasons)
            ? [
                ...new Set(reasons
                    .slice(0, 8)
                    .filter((reason) => typeof reason === 'string' && REASONS.has(reason))),
            ]
            : [],
    };
}
