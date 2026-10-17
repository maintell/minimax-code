import { isTerminalTaskStatus, normalizeTaskError, } from './domain.js';
export async function performTaskStop(context, task, reason) {
    const taskId = task.taskId;
    const stoppingResult = await context.patchStatusIfNotTerminal(task, 'stopping', {
        updatedAt: context.nowMs(),
        ...(reason ? { lastError: { message: reason, code: 'TASK_STOP_REQUESTED' } } : {}),
    });
    if (!stoppingResult.patched)
        return stoppingResult.task;
    const stopping = stoppingResult.task;
    await context.emit(stopping, 'stop_requested', { reason });
    try {
        await context.stopRuntime?.(stopping, reason);
        const settled = await context.store.get(taskId);
        if (settled && isTerminalTaskStatus(settled.status))
            return settled;
        const canceledResult = await context.patchStatusIfNotTerminal(stopping, 'canceled', {
            endedAt: context.nowMs(),
            ...(reason ? { lastError: { message: reason, code: 'TASK_CANCELED' } } : {}),
        });
        if (!canceledResult.patched)
            return canceledResult.task;
        const canceled = canceledResult.task;
        await context.emit(canceled, 'completed', { status: 'canceled' });
        return canceled;
    }
    catch (error) {
        const stopError = normalizeTaskError(error, 'TASK_STOP_FAILED');
        const settled = await context.store.patch(taskId, {
            metadata: { stopError },
        });
        if (isTerminalTaskStatus(settled.status))
            return settled;
        const canceledResult = await context.patchStatusIfNotTerminal(stopping, 'canceled', {
            endedAt: context.nowMs(),
            lastError: stopError,
        });
        if (!canceledResult.patched)
            return canceledResult.task;
        const canceled = canceledResult.task;
        await context.emit(canceled, 'completed', { status: 'canceled', stopFailed: true });
        return canceled;
    }
}
//# sourceMappingURL=task-stop.js.map