/**
 * Explicitly consume fire-and-forget Goal work. Callers pass work that already
 * owns its error handling; the call boundary makes the detachment visible to
 * the linter and the reader.
 */
export function detach(promise) {
    detached.add(promise);
    queueMicrotask(() => detached.delete(promise));
}
/** Transient strong refs so detach() visibly consumes its argument. */
const detached = new Set();
//# sourceMappingURL=detach.js.map