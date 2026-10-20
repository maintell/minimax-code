import { waitForChildBashTaskChange } from './child-bash-lifecycle.js';
import { performTaskStop } from './task-stop.js';
import { InvalidTaskStatusTransitionError, TaskNotFoundError, isTerminalTaskStatus, } from './domain.js';
import { StartupTaskRecovery } from './startup-recovery.js';
import { captureBackgroundTaskCheckpointSnapshot } from './checkpoint-snapshot.js';
import { logger } from '../common/logger.js';
import { isLocalChildWorkerSession } from '../sessions/session-policy.js';
import { KeyedOperationQueue } from '../workspace-indexing/keyed-operation-queue.js';
import { TaskWaiterRegistry, taskWaitAbortError } from './task-waiter-registry.js';
export class LocalBackgroundTaskService {
    runtimeOwner;
    startupRecovery;
    bindRuntimeOwner(owner) {
        this.runtimeOwner = owner;
    }
    store;
    outputStore;
    nowMs;
    stopRuntime;
    onTerminal;
    taskWaiters = new TaskWaiterRegistry();
    stopRequests = new Map();
    // ponytail: runtime-local cursors replay from byte 0 after restart; persist only if replay costs justify it.
    taskOutputCursors = new Map();
    taskOutputReads = new KeyedOperationQueue();
    constructor(options) {
        this.store = options.store;
        this.outputStore = options.outputStore;
        this.nowMs = options.nowMs ?? Date.now;
        this.stopRuntime = options.stopRuntime;
        this.onTerminal = options.onTerminal;
        this.startupRecovery = new StartupTaskRecovery({
            nowMs: this.nowMs,
            patchLost: (task, patch) => this.patchStatusIfNotTerminal(task, 'lost', patch),
            onStatusChanged: (task) => this.notifyTaskStatusChanged(task),
        });
    }
    async create(task) {
        const created = await this.store.create(this.runtimeOwner
            ? {
                ...task,
                metadata: { ...task.metadata, runtimeOwnerId: this.runtimeOwner.ownerId },
            }
            : task);
        this.notifyTaskChange(created);
        return created;
    }
    async get(ctxOrTaskId, maybeTaskId) {
        const ctx = typeof ctxOrTaskId === 'string' ? undefined : ctxOrTaskId;
        const taskId = typeof ctxOrTaskId === 'string' ? ctxOrTaskId : maybeTaskId;
        if (!taskId)
            return undefined;
        const task = await this.store.get(taskId);
        return isVisibleToContext(task, ctx) ? task : undefined;
    }
    async list(ctxOrQuery, maybeQuery) {
        const ctx = isToolContext(ctxOrQuery) ? ctxOrQuery : undefined;
        const query = isToolContext(ctxOrQuery) ? (maybeQuery ?? {}) : ctxOrQuery;
        return this.store.list({
            ...query,
            ...(ctx ? { ownerSessionId: ctx.sessionId } : {}),
        });
    }
    async reminderSnapshot(session) {
        return typeof session !== 'string' && isLocalChildWorkerSession(session)
            ? { tasks: [], undeliveredTotal: 0, terminalTotal: 0 }
            : this.store.reminderSnapshot(typeof session === 'string' ? session : session.sessionId, 5);
    }
    async waitForTaskChange(ownerSessionId, taskIds, signal) {
        return waitForChildBashTaskChange(this.taskWaiters, { ownerSessionId, taskIds, signal }, (taskId) => this.get(taskId));
    }
    async captureCheckpointSnapshot(ownerSessionId) {
        return captureBackgroundTaskCheckpointSnapshot({
            ownerSessionId,
            capturedAtMs: this.nowMs(),
            store: this.store,
            outputStore: this.outputStore,
        });
    }
    async markDelivered(ownerSessionId, taskIds) {
        const deliveredAt = this.nowMs();
        const delivered = [];
        for (const taskId of taskIds) {
            const task = await this.store.get(taskId);
            if (!isVisibleToOwnerSession(task, ownerSessionId) || !isTerminalTaskStatus(task.status)) {
                continue;
            }
            if (task.deliveredAt !== undefined) {
                delivered.push(task);
                continue;
            }
            delivered.push(await this.store.patch(taskId, { deliveredAt, updatedAt: deliveredAt }));
        }
        return delivered;
    }
    async reconcileStartupLostTasks(options = {}) {
        const pending = await this.startupRecovery.collect(this.store, options, this.runtimeOwner);
        return this.startupRecovery.settle(pending, options);
    }
    hasPendingStartupRecovery() {
        return this.startupRecovery.hasPending();
    }
    async pollStartupLostTasks() {
        if (!this.runtimeOwner || !this.startupRecovery.hasPending())
            return false;
        const pending = await this.startupRecovery.poll(this.store, this.runtimeOwner);
        await this.startupRecovery.settle(pending);
        return this.startupRecovery.hasPending();
    }
    async readOutput(ctxOrTaskId, taskIdOrOptions, maybeOptions) {
        const ctx = typeof ctxOrTaskId === 'string' ? undefined : ctxOrTaskId;
        const taskId = typeof ctxOrTaskId === 'string' ? ctxOrTaskId : String(taskIdOrOptions ?? '');
        const options = typeof ctxOrTaskId === 'string' ? taskIdOrOptions : maybeOptions;
        const readOptions = optionsAsReadOptions(options);
        if (ctx && readOptions?.offset === undefined) {
            const cursorKey = JSON.stringify([ctx.sessionId, taskId]);
            return this.taskOutputReads.run(cursorKey, async () => {
                if (readOptions?.signal?.aborted)
                    throw taskWaitAbortError(readOptions.signal);
                const offset = this.taskOutputCursors.get(cursorKey);
                const read = await this.readOutputAtOffset(ctx, taskId, {
                    ...(readOptions ?? {}),
                    ...(offset === undefined ? {} : { offset }),
                });
                if (readOptions?.signal?.aborted)
                    throw taskWaitAbortError(readOptions.signal);
                if (read.nextOffset !== undefined)
                    this.taskOutputCursors.set(cursorKey, read.nextOffset);
                return read;
            });
        }
        return this.readOutputAtOffset(ctx, taskId, readOptions);
    }
    async readOutputAtOffset(ctx, taskId, readOptions) {
        if (readOptions?.signal?.aborted)
            throw taskWaitAbortError(readOptions.signal);
        const waitMs = clampTaskOutputWaitMs(readOptions?.waitMs);
        const deadline = Date.now() + waitMs;
        for (;;) {
            // Register before reading the durable snapshot so output arriving between
            // the read and the await cannot become a missed wake-up.
            const waiter = waitMs > 0 ? this.taskWaiters.create(taskId, readOptions?.signal) : undefined;
            try {
                const visibleTask = await this.get(ctx ?? taskId, ctx ? taskId : undefined);
                if (!visibleTask) {
                    return { content: '', nextOffset: readOptions?.offset ?? 0 };
                }
                const read = await this.outputStore.read(taskId, readOptions);
                const task = (await this.get(ctx ?? taskId, ctx ? taskId : undefined)) ?? visibleTask;
                const hasNewOutput = read.content.length > 0 ||
                    (read.nextOffset !== undefined && read.nextOffset > (readOptions?.offset ?? 0));
                if (waitMs === 0 || hasNewOutput || isTerminalTaskStatus(task.status)) {
                    return {
                        ...read,
                        status: task.status,
                        task,
                        ...(waitMs > 0 ? { timedOut: false } : {}),
                    };
                }
                const remainingMs = deadline - Date.now();
                if (remainingMs <= 0) {
                    return { ...read, status: task.status, task, timedOut: true };
                }
                const outcome = await waiter.wait(remainingMs);
                if (outcome === 'timeout') {
                    const latestTask = await this.get(ctx ?? taskId, ctx ? taskId : undefined);
                    const latestRead = await this.outputStore.read(taskId, readOptions);
                    return {
                        ...latestRead,
                        ...(latestTask ? { status: latestTask.status, task: latestTask } : {}),
                        timedOut: true,
                    };
                }
            }
            finally {
                waiter?.cancel();
            }
        }
    }
    async stop(ctxOrTaskId, taskIdOrReason, maybeReason) {
        const ctx = typeof ctxOrTaskId === 'string' ? undefined : ctxOrTaskId;
        const taskId = typeof ctxOrTaskId === 'string' ? ctxOrTaskId : taskIdOrReason;
        const reason = typeof ctxOrTaskId === 'string' ? taskIdOrReason : maybeReason;
        if (!taskId)
            return undefined;
        const task = await this.get(ctx ?? taskId, ctx ? taskId : undefined);
        if (!task)
            return undefined;
        if (isTerminalTaskStatus(task.status))
            return task;
        // Two callers can both observe `running`. Install one shared stop promise
        // after the visibility check but before the first state mutation, then
        // make every concurrent caller reuse the attempt and its observed status.
        const pendingAfterRead = this.stopRequests.get(taskId);
        if (pendingAfterRead)
            return pendingAfterRead;
        const stopping = performTaskStop({
            store: this.store,
            nowMs: this.nowMs,
            stopRuntime: this.stopRuntime,
            patchStatusIfNotTerminal: (current, status, patch) => this.patchStatusIfNotTerminal(current, status, patch),
            onStatusChanged: (current) => this.notifyTaskStatusChanged(current),
        }, task, reason);
        this.stopRequests.set(taskId, stopping);
        try {
            return await stopping;
        }
        finally {
            if (this.stopRequests.get(taskId) === stopping)
                this.stopRequests.delete(taskId);
        }
    }
    async patch(taskId, patch) {
        const task = await this.store.patch(taskId, patch);
        if (patch.status) {
            this.notifyTaskStatusChanged(task);
        }
        return task;
    }
    async patchIfNotTerminal(taskId, patch) {
        try {
            return { task: await this.patch(taskId, patch), patched: true };
        }
        catch (error) {
            const terminal = await this.getTerminalAfterInvalidTransition(taskId, error);
            if (terminal)
                return { task: terminal, patched: false };
            throw error;
        }
    }
    async appendOutput(chunk, options = {}) {
        const deferredTask = options.persistProgress === false ? await this.store.get(chunk.taskId) : undefined;
        if (options.persistProgress === false && !deferredTask) {
            throw new TaskNotFoundError(chunk.taskId);
        }
        const outputRef = await this.outputStore.append(chunk);
        const task = deferredTask ??
            (await this.store.patch(chunk.taskId, {
                outputRef,
                updatedAt: chunk.timestamp ?? this.nowMs(),
            }));
        this.notifyTaskChange(task);
        return outputRef;
    }
    async finalizeOutput(taskId, summary) {
        await this.outputStore.finalize(taskId, summary);
    }
    patchStatus(task, status, patch) {
        return this.store.patch(task.taskId, { ...patch, status });
    }
    async patchStatusIfNotTerminal(task, status, patch) {
        try {
            return { task: await this.patchStatus(task, status, patch), patched: true };
        }
        catch (error) {
            const terminal = await this.getTerminalAfterInvalidTransition(task.taskId, error);
            if (terminal)
                return { task: terminal, patched: false };
            throw error;
        }
    }
    async getTerminalAfterInvalidTransition(taskId, error) {
        if (!(error instanceof InvalidTaskStatusTransitionError))
            return undefined;
        const current = await this.store.get(taskId);
        return current && isTerminalTaskStatus(current.status) ? current : undefined;
    }
    notifyTaskChange(task) {
        this.taskWaiters.notify(task.taskId);
        this.taskWaiters.notify(`session:${task.ownerSessionId}`);
    }
    notifyTaskStatusChanged(task) {
        this.notifyTaskChange(task);
        if (isTerminalTaskStatus(task.status))
            this.notifyTerminal(task);
    }
    notifyTerminal(task) {
        if (!this.onTerminal)
            return;
        try {
            this.onTerminal({
                taskId: task.taskId,
                ownerSessionId: task.ownerSessionId,
                status: task.status,
            });
        }
        catch (error) {
            logger.warn({
                taskId: task.taskId,
                ownerSessionId: task.ownerSessionId,
                error: error instanceof Error ? error.message : String(error),
            }, 'Local background task terminal wake hook failed');
        }
    }
}
function isVisibleToContext(task, ctx) {
    if (!task)
        return false;
    return !ctx || task.ownerSessionId === ctx.sessionId;
}
function isVisibleToOwnerSession(task, ownerSessionId) {
    return !!task && task.ownerSessionId === ownerSessionId;
}
function isToolContext(value) {
    return typeof value.sessionId === 'string';
}
function optionsAsReadOptions(value) {
    return typeof value === 'string' ? undefined : value;
}
function clampTaskOutputWaitMs(value) {
    if (!Number.isFinite(value) || value === undefined || value <= 0)
        return 0;
    return Math.min(30_000, Math.floor(value));
}
//# sourceMappingURL=service.js.map