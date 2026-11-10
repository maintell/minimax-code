import { DesktopBackgroundTaskStatus, } from '@mavis/thrift-gen/generated/desktop-service/types';
import { BackgroundTaskError, isTerminalTaskStatus, } from '@mavis/background-task/local';
import { AppError } from '../errors.js';
const statuses = {
    queued: DesktopBackgroundTaskStatus.Queued,
    running: DesktopBackgroundTaskStatus.Running,
    stopping: DesktopBackgroundTaskStatus.Stopping,
    succeeded: DesktopBackgroundTaskStatus.Succeeded,
    failed: DesktopBackgroundTaskStatus.Failed,
    canceled: DesktopBackgroundTaskStatus.Canceled,
    lost: DesktopBackgroundTaskStatus.Lost,
};
export class BackgroundTaskApplication {
    owner;
    constructor(owner) {
        this.owner = owner;
    }
    close() {
        return this.owner.close();
    }
    async listBackgroundTasks(_ctx, req) {
        requireId(req.sessionId);
        return { items: (await this.owner.service.listForApp(req.sessionId)).map(summary) };
    }
    async getBackgroundTask(_ctx, req) {
        return { task: detail(await this.get(req)) };
    }
    async readBackgroundTaskOutput(ctx, req) {
        const task = await this.get(req);
        const { offset, waitMs } = outputReadOptions(req);
        try {
            await this.owner.outputStore.verifyReadable(task.taskId, offset > 0 || hasSavedOutput(task));
            const output = await this.owner.service.readOutput(task.taskId, {
                offset,
                limitBytes: 64 * 1024,
                waitMs,
                ...(ctx.signal ? { signal: ctx.signal } : {}),
            });
            await this.owner.outputStore.verifyReadable(task.taskId, hasSavedOutput(output.task));
            return {
                content: output.content,
                nextOffset: output.nextOffset ?? offset,
                truncated: output.truncated ?? false,
                status: statuses[output.status ?? task.status],
                timedOut: output.timedOut,
            };
        }
        catch (error) {
            if (error instanceof AppError || ctx.signal?.aborted)
                throw error;
            throw new AppError(500, 'TASK_OUTPUT_UNAVAILABLE', `Cannot read background task output: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async stopBackgroundTask(_ctx, req) {
        const task = await this.get(req);
        if (!isTerminalTaskStatus(task.status)) {
            try {
                this.owner.service.assertStopOwnership(task);
            }
            catch (error) {
                if (error instanceof BackgroundTaskError)
                    throw new AppError(409, error.code, error.message);
                throw error;
            }
            this.owner.suppressDelivery(task.taskId, task.ownerSessionId);
        }
        const stopped = await this.owner.service.stop(task.taskId, 'Canceled by user');
        if (!stopped)
            throw new AppError(404, 'TASK_NOT_FOUND', 'Background task not found');
        return stoppedResponse(stopped);
    }
    async deleteBackgroundTask(ctx, req) {
        const task = await this.get(req);
        if (task.isDeleted)
            return { task: detail(task) };
        if (!isTerminalTaskStatus(task.status)) {
            const stopped = await this.stopBackgroundTask(ctx, req);
            if (stopped.operationError)
                return stopped;
        }
        return { task: detail(await this.owner.service.softDelete(task.taskId)) };
    }
    async get(req) {
        requireId(req.sessionId);
        requireId(req.taskId);
        const task = await this.owner.service.get(req.taskId);
        if (!task ||
            task.ownerSessionId !== req.sessionId ||
            task.kind !== 'bash' ||
            task.metadata?.executionMode === 'managed_foreground')
            throw new AppError(404, 'TASK_NOT_FOUND', 'Background task not found');
        return task;
    }
}
function requireId(value) {
    if (!value?.trim())
        throw new AppError(400, 'INVALID_ARGUMENT', 'Session and task identifiers are required');
}
function readError(value) {
    if (!value ||
        typeof value !== 'object' ||
        !('message' in value) ||
        typeof value.message !== 'string')
        return undefined;
    return {
        message: value.message,
        ...('code' in value && typeof value.code === 'string' ? { code: value.code } : {}),
    };
}
function summary(task) {
    const command = typeof task.metadata?.command === 'string' ? task.metadata.command : undefined;
    const stopError = readError(task.metadata?.stopError);
    return {
        taskId: task.taskId,
        ownerSessionId: task.ownerSessionId,
        displayName: task.description?.trim() || command?.trim().slice(0, 120) || '后台 Bash',
        status: statuses[task.status],
        isDeleted: task.isDeleted ?? false,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        ...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
        ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
        ...(stopError ? { stopError } : {}),
    };
}
function detail(task) {
    const metadata = task.metadata ?? {};
    const bash = record(metadata.bashDetails);
    const execution = record(bash.execution);
    const output = record(bash.output);
    return {
        ...summary(task),
        ...(typeof metadata.command === 'string' ? { command: metadata.command } : {}),
        ...(typeof metadata.workingDirectory === 'string'
            ? { workingDirectory: metadata.workingDirectory }
            : {}),
        ...(typeof execution.exitCode === 'number' ? { exitCode: execution.exitCode } : {}),
        ...(output.persistence === 'complete' || output.persistence === 'incomplete'
            ? { outputPersistence: output.persistence }
            : {}),
        ...(task.lastError ? { lastError: readError(task.lastError) } : {}),
        ...(task.outputRef?.kind === 'file' && task.outputRef.uri
            ? { outputFilePath: task.outputRef.uri }
            : {}),
    };
}
function record(value) {
    return value && typeof value === 'object' ? value : {};
}
function outputReadOptions(req) {
    const offset = Number(req.offset);
    const waitMs = req.waitMs ?? 0;
    if (!Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isInteger(waitMs) ||
        waitMs < 0 ||
        waitMs > 30_000)
        throw new AppError(400, 'INVALID_ARGUMENT', 'Invalid output offset or wait duration');
    return { offset, waitMs };
}
function hasSavedOutput(task) {
    return (task?.outputRef?.offset ?? 0) > 0;
}
function stoppedResponse(stopped) {
    const operationError = readError(stopped.metadata?.stopError) ??
        (!isTerminalTaskStatus(stopped.status)
            ? { code: 'TASK_STOP_UNCONFIRMED', message: 'Task shutdown is not confirmed' }
            : undefined);
    return { task: detail(stopped), ...(operationError ? { operationError } : {}) };
}
/**
 * Binds the prepared V2 background-task owner to the Turn system and global
 * events, and returns the applications that expose it.
 */
export function bindBackgroundTaskApplications(prepared, turnSystem, writeGlobalEvent) {
    const backgroundTasks = prepared?.backgroundTasks;
    if (!backgroundTasks)
        throw new Error('Background task owner is required');
    backgroundTasks.bindTurnAbort(turnSystem.turns.abort);
    backgroundTasks.bindPublisher((task) => {
        writeGlobalEvent({
            type: 'background_task.updated',
            payload: { sessionId: task.ownerSessionId, taskId: task.taskId },
        });
    });
    return {
        backgroundTask: new BackgroundTaskApplication(backgroundTasks),
        backgroundTaskWait: turnSystem.inspection?.backgroundTaskWait,
    };
}
//# sourceMappingURL=background-task-application.js.map