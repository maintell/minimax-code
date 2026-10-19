const hostStates = new WeakMap();
export function admitBackgroundTask(host, abort) {
    const state = getHostState(host);
    if (state.closing)
        throw new Error('Local Runtime is shutting down');
    let resolve;
    let reject;
    const settled = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    const active = { settled, ...(abort ? { abort } : {}) };
    state.active.add(active);
    void settled.then(() => state.active.delete(active), () => state.active.delete(active));
    let bound = false;
    return {
        bind: (task) => {
            if (bound)
                throw new Error('Background task admission already settled');
            bound = true;
            void task.then(resolve, reject);
        },
        release: () => {
            if (bound)
                return;
            bound = true;
            resolve();
        },
        identify: (taskId) => {
            active.taskId = taskId;
        },
    };
}
/**
 * Whether this process admitted (and therefore can actually stop) the task.
 *
 * The entry is removed as soon as the task settles, so a terminal task always
 * answers `false`; callers only need this for non-terminal rows, which are the
 * ones a cascade would otherwise mis-cancel.
 */
export function isBackgroundTaskAdmittedHere(host, taskId) {
    const state = hostStates.get(host);
    if (!state)
        return false;
    for (const task of state.active) {
        if (task.taskId === taskId)
            return true;
    }
    return false;
}
export function beginBackgroundTaskShutdown(host, reason = 'runtime-shutdown') {
    const state = getHostState(host);
    state.closing = true;
    let aborted = 0;
    for (const task of state.active) {
        if (!task.abort)
            continue;
        task.abort(reason);
        aborted += 1;
    }
    return aborted;
}
export async function drainBackgroundTasks(host) {
    const results = await Promise.allSettled([...getHostState(host).active].map(({ settled }) => settled));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure)
        throw failure.reason;
}
async function shutdownBackgroundTasks(host, reason) {
    const aborted = beginBackgroundTaskShutdown(host, reason);
    await drainBackgroundTasks(host);
    return aborted;
}
export { shutdownBackgroundTasks };
function getHostState(host) {
    let state = hostStates.get(host);
    if (!state) {
        state = { closing: false, active: new Set() };
        hostStates.set(host, state);
    }
    return state;
}
//# sourceMappingURL=lifecycle.js.map