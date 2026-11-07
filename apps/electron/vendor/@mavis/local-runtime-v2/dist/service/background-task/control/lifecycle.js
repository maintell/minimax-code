import { settleInBackground } from '../../../infra/async/settle.js';
import { logger } from '@mavis/shared/local-runtime-logging/logger';
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
    settleInBackground((async () => {
        try {
            await settled;
        }
        catch {
            /* drainBackgroundTasks reports runner failures. */
        }
        finally {
            state.active.delete(active);
        }
    })());
    let bound = false;
    return {
        bind: (task) => {
            if (bound)
                throw new Error('Background task admission already settled');
            bound = true;
            settleInBackground((async () => {
                try {
                    await task;
                    resolve();
                }
                catch (error) {
                    reject(error);
                }
            })());
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
/** Abort this task's runner, including setup before its child Turn is admitted. */
export function abortAdmittedBackgroundTask(host, taskId, reason) {
    for (const task of hostStates.get(host)?.active ?? []) {
        if (task.taskId !== taskId || !task.abort)
            continue;
        try {
            task.abort(reason);
        }
        catch {
            try {
                logger.warn({ event: 'background_task_admission_abort_failed', taskId, reason }, 'Background task admission abort failed');
            }
            catch {
                // Diagnostics must not skip the host's existing process/Turn stop.
            }
        }
    }
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