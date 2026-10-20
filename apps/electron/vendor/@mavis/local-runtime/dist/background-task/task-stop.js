import { BackgroundTaskError, isTerminalTaskStatus, normalizeTaskError, } from './domain.js';
const STOP_CONFIRMATION_TIMEOUT_MS = 15_000;
export async function performTaskStop(context, task, reason) {
    const taskId = task.taskId;
    const stoppingResult = await context.patchStatusIfNotTerminal(task, 'stopping', {
        updatedAt: context.nowMs(),
        lastError: reason ? { message: reason, code: 'TASK_STOP_REQUESTED' } : undefined,
        metadata: { stopError: undefined },
    });
    if (!stoppingResult.patched)
        return stoppingResult.task;
    const stopping = stoppingResult.task;
    context.onStatusChanged(stopping);
    let timeout;
    try {
        await Promise.race([
            context.stopRuntime?.(stopping, reason),
            new Promise((_resolve, reject) => {
                timeout = setTimeout(() => reject(new BackgroundTaskError('Timed out waiting for task shutdown confirmation', 'TASK_STOP_TIMEOUT')), STOP_CONFIRMATION_TIMEOUT_MS);
                timeout.unref?.();
            }),
        ]);
        const settled = await context.store.get(taskId);
        if (settled && isTerminalTaskStatus(settled.status))
            return settled;
        // Bash runners publish the observed exit and final output before settling.
        if (task.kind === 'bash') {
            throw new BackgroundTaskError('Bash process exit could not be confirmed by its owning runtime', 'TASK_STOP_UNCONFIRMED');
        }
        const canceledResult = await context.patchStatusIfNotTerminal(stopping, 'canceled', {
            endedAt: context.nowMs(),
            ...(reason ? { lastError: { message: reason, code: 'TASK_CANCELED' } } : {}),
        });
        if (!canceledResult.patched)
            return canceledResult.task;
        const canceled = canceledResult.task;
        context.onStatusChanged(canceled);
        return canceled;
    }
    catch (error) {
        const stopError = normalizeTaskError(error, 'TASK_STOP_FAILED');
        const settled = await context.store.patch(taskId, {
            metadata: { stopError },
        });
        if (isTerminalTaskStatus(settled.status))
            return settled;
        const failedResult = await context.patchStatusIfNotTerminal(stopping, 'stopping', {
            lastError: stopError,
        });
        if (failedResult.patched)
            context.onStatusChanged(failedResult.task);
        return failedResult.task;
    }
    finally {
        clearTimeout(timeout);
    }
}
//# sourceMappingURL=task-stop.js.map