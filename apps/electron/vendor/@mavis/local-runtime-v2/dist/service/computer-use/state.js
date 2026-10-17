let enabled = false;
let lastChangedAtMs = 0;
const abortControllers = new Set();
export function setComputerUseEnabled(next, changedAtMs) {
    if (enabled !== next) {
        enabled = next;
        lastChangedAtMs = Math.max(Date.now(), lastChangedAtMs + 1);
        if (!next)
            abortAllComputerUse();
    }
    if (changedAtMs !== undefined)
        lastChangedAtMs = changedAtMs;
    return snapshotComputerUseState();
}
export function registerComputerUseAbortController(controller) {
    abortControllers.add(controller);
    return () => abortControllers.delete(controller);
}
export function abortAllComputerUse() {
    let count = 0;
    for (const controller of [...abortControllers]) {
        if (!controller.signal.aborted) {
            controller.abort();
            count += 1;
        }
    }
    return count;
}
export function snapshotComputerUseState() {
    return { enabled, inflightCount: abortControllers.size, lastChangedAtMs };
}
export function isComputerUseEnabled() {
    return enabled;
}
//# sourceMappingURL=state.js.map