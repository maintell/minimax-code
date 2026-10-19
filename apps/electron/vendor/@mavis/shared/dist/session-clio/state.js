/**
 * Persisted Session Clio source state.
 *
 * The whole state is plain JSON — numbers, strings, booleans, plain objects and
 * arrays, with `null` for "absent" and never `undefined`. Adapters persist it
 * verbatim (SQLite TEXT on desktop, object storage on cloud) and rehydrate it
 * with `JSON.parse`; a round-tripped state continues the exact same sequence
 * and index namespaces.
 */
/** Session Clio v1: source-confirmed, one-shot QA input. */
export const SESSION_CLIO_INPUT_VERSION = 1;
/**
 * Start of the Session Clio wire sequence namespace.
 *
 * Raw Eval capture uses timestamp-shaped sequences (~1.7e12 and growing), so
 * starting at 4e15 keeps the two apart forever while staying far below
 * `Number.MAX_SAFE_INTEGER` (9.007e15).
 */
export const SESSION_CLIO_SEQUENCE_BASE = 4_000_000_000_000_000;
/** 72 hours. A Session with no new manual Query for this long is sealed. */
export const SESSION_CLIO_INACTIVITY_MS = 259_200_000;
/**
 * Create capture state for a Session.
 *
 * Eligibility lives with the caller, and it is one-shot: an adapter may only
 * create state for a Session it is capturing from its FIRST genuine Query. A
 * pre-existing Session must never opt in mid-history, because `query_index` 1
 * is the source's attestation that nothing earlier was missed.
 */
export function createSessionClioState(scope) {
    return {
        input_version: SESSION_CLIO_INPUT_VERSION,
        scope: {
            user_id: scope.user_id,
            biz_id: scope.biz_id,
            capture_origin: scope.capture_origin,
            trajectory_id: scope.trajectory_id,
        },
        first_query_at_ms: null,
        last_manual_query_at_ms: null,
        next_seq: SESSION_CLIO_SEQUENCE_BASE,
        next_query_index: 1,
        next_turn_index: 1,
        queries: [],
        turns: [],
        seal: null,
    };
}
/**
 * The first inactivity boundary, or `null` while the clock has not started.
 *
 * Manual activity resets the clock; automatic activity does not. For an
 * auto-only Session the first automatic Query still starts it, which is why
 * this is a max over both marks rather than a single one.
 */
export function sessionClioDeadlineMs(state) {
    const { first_query_at_ms, last_manual_query_at_ms } = state;
    if (first_query_at_ms === null)
        return null;
    const anchor = last_manual_query_at_ms === null
        ? first_query_at_ms
        : Math.max(first_query_at_ms, last_manual_query_at_ms);
    return anchor + SESSION_CLIO_INACTIVITY_MS;
}
/** Whether the source has frozen this Session. Sealed state never emits again. */
export function isSessionClioSealed(state) {
    return state.seal !== null;
}
//# sourceMappingURL=state.js.map