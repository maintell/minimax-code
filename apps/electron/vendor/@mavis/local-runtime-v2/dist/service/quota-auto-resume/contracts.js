/** Consecutive automatic retries after which the Runtime stops planning. */
export const QUOTA_AUTO_RESUME_MAX_AUTO_RETRY = 2;
/** An interruption older than this is never resumed automatically after a restart. */
export const QUOTA_AUTO_RESUME_STALE_MS = 24 * 60 * 60 * 1000;
/**
 * Upper bound of the random spread added on top of a reported reset instant.
 * Every Session of one account shares a single 5h window, so they all compute
 * the same arrival; without a spread they continue in the same millisecond.
 */
export const QUOTA_AUTO_RESUME_JITTER_MAX_MS = 30_000;
/** The one key format both the observer and the service use for a Turn. */
export function quotaAutoResumeTurnKey(turn) {
    return `${turn.sessionId}\0${turn.turnId}`;
}
//# sourceMappingURL=contracts.js.map