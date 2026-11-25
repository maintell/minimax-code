/**
 * The desktop policy when the Hosts were unified:
 * - stages: the desktop reviews user input, assistant output and thinking; it has no
 *   tool-stage review backend.
 * - maxRetries 3: `OUTPUT_SAFETY_LOCAL_ERROR_MAX_RETRIES` (runner/output/output-safety-event-writer.ts).
 * - timeoutMs 20 s: `SAFETY_CHECK_V2_TIMEOUT_MS` (`@mavis/shared/safety-check-v2`), the
 *   timeout of the V2 review the desktop dialog uses.
 */
export const DEFAULT_SAFETY_POLICY = Object.freeze({
    enabledStages: Object.freeze(['input', 'output', 'thinking']),
    maxRetries: 3,
    timeoutMs: 20_000,
});
/** Random backoff bound before a retry: `OUTPUT_SAFETY_LOCAL_ERROR_RETRY_MAX_DELAY_MS`. */
const SAFETY_RETRY_MAX_DELAY_MS = 5_000;
const CHECK_FAILED = { kind: 'unavailable', cause: 'transport' };
const CHECK_TIMED_OUT = { kind: 'unavailable', cause: 'timeout' };
/** The configured policy, or the default one; a malformed policy fails the run closed. */
export function resolveSafetyPolicy(policy) {
    if (!policy)
        return DEFAULT_SAFETY_POLICY;
    if (!Number.isInteger(policy.maxRetries) || policy.maxRetries < 0) {
        throw new Error(`SafetyPolicy.maxRetries must be a non-negative integer: ${policy.maxRetries}`);
    }
    if (!Number.isFinite(policy.timeoutMs) || policy.timeoutMs <= 0) {
        throw new Error(`SafetyPolicy.timeoutMs must be a positive number: ${policy.timeoutMs}`);
    }
    return policy;
}
/**
 * Settles with `onTimeout` when `review` is still running after `timeoutMs`. The review
 * port has no signal, so the request itself runs on until its transport timeout.
 */
export async function withSafetyTimeout(review, timeoutMs, onTimeout) {
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(onTimeout), timeoutMs);
    });
    try {
        return await Promise.race([review, timeout]);
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * One Host check under the policy timeout. A throw or rejection is `transport`; a timeout
 * aborts the check signal. When `signal` aborts the promise settles at once and the caller
 * must ignore the verdict.
 */
export async function boundedSafetyCheck(check, input, signal, timeoutMs) {
    const controller = new AbortController();
    let timer;
    let onAbort = () => undefined;
    const stopped = new Promise((resolve) => {
        onAbort = () => {
            controller.abort(signal.reason);
            resolve(CHECK_FAILED);
        };
        timer = setTimeout(() => {
            controller.abort(new Error('Content safety check timed out.'));
            resolve(CHECK_TIMED_OUT);
        }, timeoutMs);
        signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        return await Promise.race([runCheck(check, input, controller.signal), stopped]);
    }
    finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
    }
}
/** The Host check as a verdict; a synchronous throw or a rejection is `transport`. */
async function runCheck(check, input, signal) {
    try {
        return await check(input, signal);
    }
    catch {
        return CHECK_FAILED;
    }
}
/** Random 0–5 s backoff before a retry; ends early when `signal` aborts. */
export function safetyRetryDelay(signal, random = Math.random) {
    if (signal.aborted)
        return Promise.resolve();
    return new Promise((resolve) => {
        const done = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
        };
        const timer = setTimeout(done, Math.floor(random() * (SAFETY_RETRY_MAX_DELAY_MS + 1)));
        signal.addEventListener('abort', done, { once: true });
    });
}
//# sourceMappingURL=policy.js.map