import { backgroundTaskNotificationReceiptId } from '@mavis/agent-tools/desktop';
const TERMINAL_BACKGROUND_TASK_STATUSES = new Set(['succeeded', 'failed', 'canceled', 'lost']);
/**
 * Derives each terminal Task's notification state from durable facts only: the Task row and
 * the Turn ingress receipt its delivery bound to the admitting Turn. User-stop suppression is
 * the one process-local input, and it can only end a notification, never start one.
 */
export function createBackgroundTaskNotificationProjection(api) {
    let receipts;
    return {
        bind: (next) => {
            receipts = next;
        },
        annotate: async (ownerSessionId, tasks) => {
            const terminal = tasks.filter((task) => TERMINAL_BACKGROUND_TASK_STATUSES.has(task.status));
            if (!receipts || terminal.length === 0)
                return tasks;
            const receiptIds = terminal.map(({ taskId }) => backgroundTaskNotificationReceiptId(taskId));
            let bindings;
            try {
                bindings = await receipts.findClientRequestBindings({
                    sessionId: ownerSessionId,
                    clientRequestIds: receiptIds,
                });
            }
            catch (error) {
                try {
                    api.matrixLogger?.warn({ sessionId: ownerSessionId, turnId: 'background-task-notification' }, `Background Task notification receipts could not be read: ${String(error)}`);
                }
                catch {
                    // Diagnostics are best-effort.
                }
                return tasks; // Unreadable ledger: state stays unknown (absent), read as settled.
            }
            const byReceiptId = new Map(bindings.map((binding) => [binding.clientRequestId, binding]));
            return tasks.map((task) => {
                if (!TERMINAL_BACKGROUND_TASK_STATUSES.has(task.status))
                    return task;
                const binding = byReceiptId.get(backgroundTaskNotificationReceiptId(task.taskId));
                return { ...task, notification: backgroundTaskNotificationState(api, task, binding) };
            });
        },
    };
}
function backgroundTaskNotificationState(api, task, binding) {
    // Steered into a running Turn or admitted as a new one: the owner has it, however long it runs.
    if (binding)
        return { state: 'settled', turnId: binding.turnId };
    // A result already read by a completed Turn, or a stop the user asked for, never wakes it.
    if (task.deliveredAt !== undefined || api.backgroundTasks.isDeliverySuppressed(task.taskId)) {
        return { state: 'settled' };
    }
    return { state: 'pending' };
}
//# sourceMappingURL=background-task-notifications.js.map