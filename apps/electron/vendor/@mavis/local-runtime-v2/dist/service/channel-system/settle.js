/**
 * Awaited replacements for the v1 `.catch(() => fallback)` expression idiom.
 *
 * The v2 lint forbids raw Promise combinators; these helpers keep the exact
 * "settle quietly with a fallback" semantics at call sites where a failure is
 * genuinely non-actionable (the callers document why).
 */
/** Await `promise`; a rejection resolves to `undefined`. */
export async function settleOrUndefined(promise) {
    try {
        return await promise;
    }
    catch {
        return undefined;
    }
}
/** Await `promise`; a rejection resolves to `fallback`. */
export async function settleOr(promise, fallback) {
    try {
        return await promise;
    }
    catch {
        return fallback;
    }
}
/** Await `promise` solely for settlement; rejections are swallowed. */
export async function settleQuietly(promise) {
    try {
        await promise;
    }
    catch {
        // Callers use this only where failure is non-actionable by contract.
    }
}
/**
 * Explicitly consume a fire-and-forget promise. Callers pass work that
 * already owns its error handling (never rejects); the call boundary makes
 * the detachment visible to the linter and the reader.
 */
export function detach(promise) {
    detached.add(promise);
    queueMicrotask(() => detached.delete(promise));
}
/** Transient strong refs so detach() visibly consumes its argument. */
const detached = new Set();
//# sourceMappingURL=settle.js.map