import { randomUUID } from 'node:crypto';
export const BACKGROUND_TASK_CHECKPOINT_DETAILS_HINT = 'Call task_query for the live task list, then task_output(task_id) for progress or results.';
export class BackgroundTaskError extends Error {
    code;
    details;
    constructor(message, code, details) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = 'BackgroundTaskError';
    }
}
export class TaskNotFoundError extends BackgroundTaskError {
    constructor(taskId) {
        super(`Background task not found: ${taskId}`, 'TASK_NOT_FOUND', { taskId });
        this.name = 'TaskNotFoundError';
    }
}
export class TaskAlreadyExistsError extends BackgroundTaskError {
    constructor(taskId) {
        super(`Background task already exists: ${taskId}`, 'TASK_ALREADY_EXISTS', { taskId });
        this.name = 'TaskAlreadyExistsError';
    }
}
export class InvalidTaskStatusTransitionError extends BackgroundTaskError {
    constructor(taskId, from, to) {
        super(`Invalid background task status transition for ${taskId}: ${from} -> ${to}`, 'INVALID_TASK_STATUS_TRANSITION', { taskId, from, to });
        this.name = 'InvalidTaskStatusTransitionError';
    }
}
export function createBackgroundTaskId() {
    return `bg_${randomUUID()}`;
}
export function createTaskLifecycleEventId() {
    return `bge_${randomUUID()}`;
}
export function isTerminalTaskStatus(status) {
    return ['succeeded', 'failed', 'canceled', 'lost'].includes(status);
}
export function canTransitionTaskStatus(from, to) {
    if (from === to)
        return true;
    if (isTerminalTaskStatus(from))
        return false;
    switch (from) {
        case 'queued':
            return ['running', 'stopping', 'succeeded', 'failed', 'canceled', 'lost'].includes(to);
        case 'running':
            return ['stopping', 'succeeded', 'failed', 'canceled', 'lost'].includes(to);
        case 'stopping':
            return ['succeeded', 'failed', 'canceled', 'lost'].includes(to);
        default:
            return false;
    }
}
export function normalizeTaskError(error, fallbackCode = 'TASK_ERROR') {
    if (error instanceof BackgroundTaskError) {
        return {
            message: error.message,
            code: error.code,
            details: error.details,
        };
    }
    if (error instanceof Error) {
        return {
            message: error.message,
            code: fallbackCode,
            ...(error.stack ? { details: { stack: error.stack } } : {}),
        };
    }
    return {
        message: String(error),
        code: fallbackCode,
    };
}
//# sourceMappingURL=domain.js.map