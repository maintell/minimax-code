import { isTerminalTaskStatus, } from '@mavis/background-task/local';
export function matchesQuery(task, query) {
    if (query.taskIds && !query.taskIds.includes(task.taskId))
        return false;
    if (query.ownerSessionId && task.ownerSessionId !== query.ownerSessionId)
        return false;
    if (query.parentTaskId !== undefined && (task.parentTaskId ?? null) !== query.parentTaskId) {
        return false;
    }
    return (matchesKindAndStatus(task, query) &&
        matchesTimeRange(task, query) &&
        matchesDelivery(task, query));
}
function matchesKindAndStatus(task, query) {
    if (query.kinds && !query.kinds.includes(task.kind))
        return false;
    if (query.statuses && !query.statuses.includes(task.status))
        return false;
    return true;
}
function matchesTimeRange(task, query) {
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
function matchesDelivery(task, query) {
    if (query.undeliveredOnly &&
        (!isTerminalTaskStatus(task.status) || task.deliveredAt !== undefined)) {
        return false;
    }
    return true;
}
export function getOrderValue(task, orderBy) {
    if (orderBy === 'updated_at')
        return task.updatedAt;
    if (orderBy === 'completed_at')
        return task.endedAt ?? 0;
    return task.createdAt;
}
//# sourceMappingURL=task-query.js.map