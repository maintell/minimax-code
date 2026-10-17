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
export class TaskRunnerNotFoundError extends BackgroundTaskError {
    constructor(kind) {
        super(`No background task runner registered for kind: ${kind}`, 'TASK_RUNNER_NOT_FOUND', {
            kind,
        });
        this.name = 'TaskRunnerNotFoundError';
    }
}
export class TaskRunnerAlreadyRegisteredError extends BackgroundTaskError {
    constructor(kind) {
        super(`Background task runner already registered for kind: ${kind}`, 'TASK_RUNNER_EXISTS', {
            kind,
        });
        this.name = 'TaskRunnerAlreadyRegisteredError';
    }
}
export class InvalidTaskStatusTransitionError extends BackgroundTaskError {
    constructor(taskId, from, to) {
        super(`Invalid background task status transition for ${taskId}: ${from} -> ${to}`, 'INVALID_TASK_STATUS_TRANSITION', { taskId, from, to });
        this.name = 'InvalidTaskStatusTransitionError';
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
            details: error.stack ? { stack: error.stack } : undefined,
        };
    }
    return {
        message: String(error),
        code: fallbackCode,
    };
}
//# sourceMappingURL=errors.js.map