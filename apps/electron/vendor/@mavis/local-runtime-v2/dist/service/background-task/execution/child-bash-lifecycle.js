import { isTerminalTaskStatus } from '@mavis/background-task/local';
import { taskWaitAbortError } from '../state/task-waiter-registry.js';
import { buildBackgroundTaskDeliveryPrompt } from './delivery-prompt.js';
/** A child Turn owns its Bash continuations; terminal events must never start a new child Turn. */
export function createChildBashLifecycle(service, input) {
    const notified = new Set();
    const listOwned = async () => {
        const tasks = [];
        let cursor;
        do {
            const page = await service.list({
                ownerSessionId: input.sessionId,
                kinds: ['bash'],
                limit: 100,
                ...(cursor ? { cursor } : {}),
            });
            tasks.push(...page.items.filter((task) => task.metadata?.parentTurnId === input.turnId));
            cursor = page.nextCursor;
        } while (cursor);
        return tasks;
    };
    return {
        async hasPending() {
            return (await listOwned()).some((task) => !isTerminalTaskStatus(task.status));
        },
        async poll(options) {
            const signal = options.steeringSignal
                ? AbortSignal.any([input.signal, options.steeringSignal])
                : input.signal;
            let waiting = false;
            const pollUntilReady = async () => {
                for (;;) {
                    if (steeringInterrupted(input.signal, options.steeringSignal))
                        return undefined;
                    const tasks = await listOwned();
                    const unread = tasks.filter((task) => isTerminalTaskStatus(task.status) &&
                        task.deliveredAt === undefined &&
                        !notified.has(task.taskId) &&
                        !options.readTaskIds.has(task.taskId));
                    if (unread.length > 0) {
                        for (const task of unread)
                            notified.add(task.taskId);
                        return buildBackgroundTaskDeliveryPrompt(unread);
                    }
                    const pending = tasks.filter((task) => !isTerminalTaskStatus(task.status));
                    if (!options.wait || pending.length === 0)
                        return undefined;
                    if (!waiting) {
                        waiting = true;
                        options.onWaitingChanged?.(true);
                    }
                    // No model polling and no new Turn: keep the accepted child lease until its Bash settles.
                    try {
                        await service.waitForTaskChange(input.sessionId, pending.map((task) => task.taskId), signal);
                    }
                    catch (error) {
                        if (steeringInterrupted(input.signal, options.steeringSignal))
                            return undefined;
                        throw error;
                    }
                }
            };
            try {
                return await pollUntilReady();
            }
            finally {
                if (waiting)
                    options.onWaitingChanged?.(false);
            }
        },
        async close() {
            const pending = (await listOwned()).filter((task) => !isTerminalTaskStatus(task.status));
            const results = await Promise.allSettled(pending.map((task) => service.stop(task.taskId, 'Owning child Turn ended')));
            const failures = results.flatMap((result) => {
                if (result.status === 'rejected')
                    return [result.reason];
                const task = result.value;
                if (!task || !isTerminalTaskStatus(task.status) || task.metadata?.stopError)
                    return [new Error('Child Bash shutdown is not confirmed')];
                return [];
            });
            if (failures.length > 0)
                throw new AggregateError(failures, 'Failed to stop child Bash tasks');
        },
    };
}
/** Register first, then read durable state: a completion racing admission cannot be missed. */
export async function waitForChildBashTaskChange(waiters, input, getTask) {
    if (input.signal.aborted)
        throw taskWaitAbortError(input.signal);
    const waiter = waiters.create(`session:${input.ownerSessionId}`, input.signal);
    try {
        const tasks = await Promise.all(input.taskIds.map(getTask));
        if (tasks.some((task) => !task ||
            task.ownerSessionId !== input.ownerSessionId ||
            isTerminalTaskStatus(task.status)))
            return;
        await waiter.wait(30_000);
    }
    finally {
        waiter.cancel();
    }
}
function steeringInterrupted(signal, steeringSignal) {
    if (signal.aborted)
        throw taskWaitAbortError(signal);
    return steeringSignal?.aborted ?? false;
}
//# sourceMappingURL=child-bash-lifecycle.js.map