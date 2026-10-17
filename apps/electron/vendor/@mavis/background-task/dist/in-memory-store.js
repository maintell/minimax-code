import { InvalidTaskStatusTransitionError, TaskAlreadyExistsError, TaskNotFoundError, } from './errors.js';
import { canTransitionTaskStatus } from './status.js';
const DEFAULT_TASK_LIST_LIMIT = 100;
const MAX_TASK_LIST_LIMIT = 500;
export class InMemoryTaskStore {
    tasks = new Map();
    events = [];
    now;
    constructor(options = {}) {
        this.now = options.now ?? Date.now;
    }
    async create(task) {
        if (this.tasks.has(task.taskId)) {
            throw new TaskAlreadyExistsError(task.taskId);
        }
        const stored = cloneTask(task);
        this.tasks.set(task.taskId, stored);
        return cloneTask(stored);
    }
    async get(taskId) {
        const task = this.tasks.get(taskId);
        return task ? cloneTask(task) : undefined;
    }
    async list(query) {
        const order = query.order ?? 'desc';
        const orderBy = query.orderBy ?? 'created_at';
        const offset = parseCursor(query.cursor);
        const limit = clampLimit(query.limit);
        let items = [...this.tasks.values()];
        items = items.filter((task) => matchesQuery(task, query));
        items.sort((left, right) => {
            const leftValue = getOrderValue(left, orderBy);
            const rightValue = getOrderValue(right, orderBy);
            return order === 'asc' ? leftValue - rightValue : rightValue - leftValue;
        });
        const page = items.slice(offset, offset + limit).map(cloneTask);
        const nextOffset = offset + page.length;
        return {
            items: page,
            nextCursor: nextOffset < items.length ? String(nextOffset) : undefined,
        };
    }
    async patch(taskId, patch) {
        const current = this.tasks.get(taskId);
        if (!current)
            throw new TaskNotFoundError(taskId);
        if (patch.status && !canTransitionTaskStatus(current.status, patch.status)) {
            throw new InvalidTaskStatusTransitionError(taskId, current.status, patch.status);
        }
        const updated = {
            ...current,
            ...patch,
            metadata: mergeRecord(current.metadata, patch.metadata),
            updatedAt: patch.updatedAt ?? this.now(),
        };
        this.tasks.set(taskId, cloneTask(updated));
        return cloneTask(updated);
    }
    async updateStatus(taskId, status, reason) {
        const patch = { status };
        if (reason && ['failed', 'canceled', 'lost'].includes(status)) {
            patch.lastError = { message: reason, code: status.toUpperCase() };
        }
        return this.patch(taskId, patch);
    }
    async appendEvent(event) {
        this.events.push(cloneEvent(event));
    }
    listEvents(taskId) {
        return this.events.filter((event) => !taskId || event.taskId === taskId).map(cloneEvent);
    }
}
function matchesQuery(task, query) {
    if (query.taskIds && !query.taskIds.includes(task.taskId))
        return false;
    if (query.ownerSessionId && task.ownerSessionId !== query.ownerSessionId)
        return false;
    if (query.parentTaskId !== undefined && (task.parentTaskId ?? null) !== query.parentTaskId) {
        return false;
    }
    if (query.kinds && !query.kinds.includes(task.kind))
        return false;
    if (query.statuses && !query.statuses.includes(task.status))
        return false;
    if (query.createdAfter !== undefined && task.createdAt < query.createdAfter)
        return false;
    if (query.createdBefore !== undefined && task.createdAt > query.createdBefore)
        return false;
    if (query.updatedAfter !== undefined && task.updatedAt < query.updatedAfter)
        return false;
    if (query.updatedBefore !== undefined && task.updatedAt > query.updatedBefore)
        return false;
    return true;
}
function getOrderValue(task, orderBy) {
    if (orderBy === 'updated_at')
        return task.updatedAt;
    if (orderBy === 'completed_at')
        return task.endedAt ?? 0;
    return task.createdAt;
}
function parseCursor(cursor) {
    if (!cursor)
        return 0;
    const value = Number.parseInt(cursor, 10);
    return Number.isFinite(value) && value > 0 ? value : 0;
}
function clampLimit(limit) {
    if (limit === undefined)
        return DEFAULT_TASK_LIST_LIMIT;
    if (limit <= 0)
        return DEFAULT_TASK_LIST_LIMIT;
    return Math.min(Math.floor(limit), MAX_TASK_LIST_LIMIT);
}
function mergeRecord(current, patch) {
    if (!current && !patch)
        return undefined;
    return { ...(current ?? {}), ...(patch ?? {}) };
}
function cloneTask(task) {
    return {
        ...task,
        outputRef: task.outputRef
            ? { ...task.outputRef, metadata: cloneRecord(task.outputRef.metadata) }
            : undefined,
        lastError: task.lastError
            ? { ...task.lastError, details: cloneRecord(task.lastError.details) }
            : undefined,
        usage: task.usage ? { ...task.usage, metadata: cloneRecord(task.usage.metadata) } : undefined,
        metadata: cloneRecord(task.metadata),
    };
}
function cloneEvent(event) {
    return {
        ...event,
        payload: cloneRecord(event.payload),
    };
}
function cloneRecord(value) {
    return (value ? { ...value } : undefined);
}
//# sourceMappingURL=in-memory-store.js.map