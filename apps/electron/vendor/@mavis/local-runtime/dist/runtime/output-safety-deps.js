/** Sliding-window flush threshold in characters (matches archon-server charsThreshold). */
export const OUTPUT_SAFETY_CHUNK_THRESHOLD = 80;
/**
 * Retries of a single review window when the call resolves to `local_error`
 * (no verdict: offline / timeout / 4xx auth / unusable body) — an infra
 * failure, not a content verdict, so retrying the SAME text may succeed once
 * the hiccup clears. Total attempts = 1 initial + this many; on exhaustion the
 * writer soft-stops the turn (see `LocalOutputSafetyEventWriter.networkStopped`).
 */
export const OUTPUT_SAFETY_LOCAL_ERROR_MAX_RETRIES = 3;
/**
 * Upper bound (ms) of the randomized backoff before each `local_error` retry:
 * a uniform random in `[0, this]`, jitter that avoids hammering an unreachable
 * gateway and de-syncs concurrent turns. Not applied before the initial call,
 * nor for a real `rejected` / `api_error` verdict.
 */
export const OUTPUT_SAFETY_LOCAL_ERROR_RETRY_MAX_DELAY_MS = 5_000;
/** Default randomized backoff before re-submitting one `local_error` review window. */
export function defaultOutputSafetyLocalErrorRetryDelay() {
    const delayMs = Math.floor(Math.random() * (OUTPUT_SAFETY_LOCAL_ERROR_RETRY_MAX_DELAY_MS + 1));
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}
//# sourceMappingURL=output-safety-deps.js.map