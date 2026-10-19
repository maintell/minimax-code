export const DEFAULT_INITIAL_PREPARATION_TIMEOUT_MS = 30_000;
export class WorkspaceInitialPreparationTimeoutError extends Error {
    timeoutMs;
    name = 'WorkspaceInitialPreparationTimeoutError';
    constructor(timeoutMs) {
        super(`workspace_initial_preparation_timed_out:${timeoutMs}`);
        this.timeoutMs = timeoutMs;
    }
}
export async function runInitialPreparationWithDeadline(timeoutMs, operation) {
    const controller = new AbortController();
    let timer;
    const timedOut = new Promise((resolve) => {
        timer = setTimeout(() => {
            controller.abort(new WorkspaceInitialPreparationTimeoutError(timeoutMs));
            resolve({ status: 'timed_out' });
        }, timeoutMs);
    });
    const completed = operation(controller.signal).then((value) => ({ status: 'completed', value }));
    try {
        return await Promise.race([completed, timedOut]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
export function normalizeInitialPreparationTimeoutMs(value) {
    const timeoutMs = value ?? DEFAULT_INITIAL_PREPARATION_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new RangeError(`invalid_workspace_initial_preparation_timeout:${timeoutMs}`);
    }
    return Math.floor(timeoutMs);
}
//# sourceMappingURL=initial-preparation-deadline.js.map