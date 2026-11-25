import { isTerminalTaskStatus } from '@mavis/background-task/local';
import { taskWaitAbortError } from '../state/task-waiter-registry.js';
/** How long a task's Turn waits at its natural end for subagents it started. */
const TASK_SUBAGENT_WAIT_MAX_MS = 30 * 60_000;
/**
 * After one of them finishes, how long the Turn stays open for the ordinary background
 * delivery to steer its result in, so the result joins this Turn instead of starting one.
 */
const TASK_SUBAGENT_RESULT_GRACE_MS = 5_000;
/**
 * A Bunny task's Turn waits for the background subagents it started before it ends, so it
 * reports after their results instead of before them. Their results still arrive through
 * the ordinary background delivery, which steers into this running Turn: this only keeps
 * the Turn open, it neither builds notices nor marks results read. Background commands are
 * not waited for (a server the task left running must not hold its Turn), and nothing is
 * stopped when the Turn ends. The wait is bounded; past it the Turn ends as before and the
 * review keeps the task open while its background work still runs.
 */
export function createTaskSubagentWait(service, input) {
    const now = input.nowMs ?? Date.now;
    const maxWaitMs = input.maxWaitMs ?? TASK_SUBAGENT_WAIT_MAX_MS;
    const graceMs = input.resultGraceMs ?? TASK_SUBAGENT_RESULT_GRACE_MS;
    let deadline;
    /** Finished subagents already given their grace: each holds the Turn once. */
    const graced = new Set();
    const listOwned = async () => {
        const tasks = [];
        let cursor;
        do {
            const page = await service.list({
                ownerSessionId: input.sessionId,
                kinds: ['subagent'],
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
            if (deadline !== undefined && now() >= deadline)
                return false;
            return (await listOwned()).some((task) => !isTerminalTaskStatus(task.status));
        },
        async poll(options) {
            if (!options.wait)
                return undefined;
            const bound = (deadline ??= now() + maxWaitMs);
            const scope = {
                sessionId: input.sessionId,
                signal: input.signal,
                steeringSignal: options.steeringSignal,
                deadline: bound,
                now,
            };
            let waiting = false;
            const setWaiting = () => {
                if (waiting)
                    return;
                waiting = true;
                options.onWaitingChanged?.(true);
            };
            /** Each finished subagent holds the Turn once, for the delivery that steers it in. */
            const grace = async (unread) => {
                for (const task of unread)
                    graced.add(task.taskId);
                setWaiting();
                await pause(Math.min(graceMs, bound - now()), input.signal, options.steeringSignal);
            };
            try {
                for (;;) {
                    if (interrupted(input.signal, options.steeringSignal) || now() >= bound)
                        return undefined;
                    const { unread, pending } = classify(await listOwned(), graced, options.readTaskIds);
                    if (unread.length > 0) {
                        await grace(unread);
                        continue;
                    }
                    if (pending.length === 0)
                        return undefined;
                    setWaiting();
                    if ((await awaitChange(service, scope, pending)) === 'stopped')
                        return undefined;
                }
            }
            finally {
                if (waiting)
                    options.onWaitingChanged?.(false);
            }
        },
        /** Subagents outlive the Turn that started them: nothing is stopped here. */
        async close() { },
    };
}
/** The finished-but-undelivered subagents, and the ones still running. */
function classify(tasks, graced, readTaskIds) {
    return {
        unread: tasks.filter((task) => isTerminalTaskStatus(task.status) &&
            task.deliveredAt === undefined &&
            !graced.has(task.taskId) &&
            !readTaskIds.has(task.taskId)),
        pending: tasks.filter((task) => !isTerminalTaskStatus(task.status)),
    };
}
/** Blocks until one of them changes; `stopped` when the wait itself ended. */
async function awaitChange(service, scope, pending) {
    const timeout = AbortSignal.timeout(Math.max(0, scope.deadline - scope.now()));
    try {
        await service.waitForTaskChange(scope.sessionId, pending.map((task) => task.taskId), AbortSignal.any([
            scope.signal,
            timeout,
            ...(scope.steeringSignal ? [scope.steeringSignal] : []),
        ]));
        return 'changed';
    }
    catch (error) {
        if (interrupted(scope.signal, scope.steeringSignal) || timeout.aborted)
            return 'stopped';
        throw error;
    }
}
/** Throws when the Turn itself was cancelled; true when steering input arrived. */
function interrupted(signal, steeringSignal) {
    if (signal.aborted)
        throw taskWaitAbortError(signal);
    return steeringSignal?.aborted ?? false;
}
function pause(ms, signal, steeringSignal) {
    return new Promise((resolve) => {
        const signals = [signal, ...(steeringSignal ? [steeringSignal] : [])];
        const done = () => {
            clearTimeout(timer);
            for (const each of signals)
                each.removeEventListener('abort', done);
            resolve();
        };
        const timer = setTimeout(done, Math.max(0, ms));
        for (const each of signals) {
            if (each.aborted)
                return done();
            each.addEventListener('abort', done, { once: true });
        }
    });
}
//# sourceMappingURL=task-subagent-wait.js.map