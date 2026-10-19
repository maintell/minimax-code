import { TaskNotFoundError, TaskRunnerAlreadyRegisteredError, TaskRunnerNotFoundError, normalizeTaskError, } from './errors.js';
import { createBackgroundTaskId, createTaskLifecycleEventId } from './id.js';
import { isTerminalTaskStatus } from './status.js';
export class DefaultBackgroundTaskManager {
    store;
    outputStore;
    runners = new Map();
    now;
    taskIdGenerator;
    eventIdGenerator;
    sequence = 0;
    constructor(options) {
        this.store = options.store;
        this.outputStore = options.outputStore;
        this.now = options.now ?? Date.now;
        this.taskIdGenerator = options.taskIdGenerator ?? createBackgroundTaskId;
        this.eventIdGenerator = options.eventIdGenerator ?? createTaskLifecycleEventId;
        for (const runner of options.runners ?? []) {
            this.registerRunner(runner);
        }
    }
    registerRunner(runner) {
        if (this.runners.has(runner.kind)) {
            throw new TaskRunnerAlreadyRegisteredError(runner.kind);
        }
        this.runners.set(runner.kind, runner);
    }
    async start(request) {
        const runner = this.getRunner(request.kind);
        const now = this.now();
        const task = {
            taskId: this.taskIdGenerator(),
            kind: request.kind,
            status: 'queued',
            ownerSessionId: request.ownerSessionId,
            description: request.description,
            toolCallId: request.toolCallId,
            parentMessageId: request.parentMessageId,
            parentTaskId: request.parentTaskId,
            createdAt: now,
            updatedAt: now,
            metadata: request.metadata ? { ...request.metadata } : undefined,
        };
        const created = await this.store.create(task);
        await this.emit(created, 'created', { inputKind: request.kind });
        try {
            const handle = await runner.start(created, request.input);
            const startedPatch = {
                status: 'running',
                startedAt: this.now(),
            };
            if (handle.outputRef)
                startedPatch.outputRef = handle.outputRef;
            const started = await this.store.patch(created.taskId, startedPatch);
            await this.emit(started, 'started', {
                hasOutputRef: Boolean(handle.outputRef),
            });
            return started;
        }
        catch (error) {
            const failed = await this.store.patch(created.taskId, {
                status: 'failed',
                endedAt: this.now(),
                lastError: normalizeTaskError(error, 'TASK_START_FAILED'),
            });
            await this.emit(failed, 'completed', { status: 'failed' });
            return failed;
        }
    }
    async get(taskId) {
        return this.store.get(taskId);
    }
    async list(query) {
        return this.store.list(query);
    }
    async readOutput(taskId, options) {
        return this.outputStore.read(taskId, options);
    }
    async stop(taskId, reason) {
        const task = await this.requireTask(taskId);
        if (isTerminalTaskStatus(task.status))
            return task;
        if (task.status === 'stopping')
            return task;
        const stopping = await this.store.patch(taskId, { status: 'stopping' });
        await this.emit(stopping, 'stop_requested', { reason });
        try {
            await this.getRunner(task.kind).stop(taskId, reason);
            const canceledPatch = {
                status: 'canceled',
                endedAt: this.now(),
            };
            if (reason)
                canceledPatch.lastError = { message: reason, code: 'TASK_CANCELED' };
            const canceled = await this.store.patch(taskId, canceledPatch);
            await this.emit(canceled, 'completed', { status: 'canceled' });
            return canceled;
        }
        catch (error) {
            const canceled = await this.store.patch(taskId, {
                status: 'canceled',
                endedAt: this.now(),
                lastError: normalizeTaskError(error, 'TASK_STOP_FAILED'),
            });
            await this.emit(canceled, 'completed', { status: 'canceled', stopFailed: true });
            return canceled;
        }
    }
    async complete(taskId, options = {}) {
        const task = await this.requireTask(taskId);
        if (isTerminalTaskStatus(task.status))
            return task;
        if (options.summary !== undefined) {
            await this.outputStore.finalize(taskId, options.summary);
        }
        const completedPatch = {
            status: options.status ?? 'succeeded',
            endedAt: this.now(),
        };
        if (options.outputRef)
            completedPatch.outputRef = options.outputRef;
        if (options.usage)
            completedPatch.usage = options.usage;
        if (options.metadata)
            completedPatch.metadata = options.metadata;
        const completed = await this.store.patch(taskId, completedPatch);
        await this.emit(completed, 'completed', { status: completed.status });
        return completed;
    }
    async fail(taskId, error) {
        const task = await this.requireTask(taskId);
        if (isTerminalTaskStatus(task.status))
            return task;
        const failed = await this.store.patch(taskId, {
            status: 'failed',
            endedAt: this.now(),
            lastError: normalizeTaskError(error),
        });
        await this.emit(failed, 'completed', { status: 'failed' });
        return failed;
    }
    getRunner(kind) {
        const runner = this.runners.get(kind);
        if (!runner)
            throw new TaskRunnerNotFoundError(kind);
        return runner;
    }
    async requireTask(taskId) {
        const task = await this.store.get(taskId);
        if (!task)
            throw new TaskNotFoundError(taskId);
        return task;
    }
    async emit(task, type, payload) {
        const event = {
            eventId: this.eventIdGenerator(),
            taskId: task.taskId,
            ownerSessionId: task.ownerSessionId,
            type,
            timestamp: this.now(),
            sequence: ++this.sequence,
            payload,
        };
        await this.store.appendEvent(event);
    }
}
//# sourceMappingURL=manager.js.map