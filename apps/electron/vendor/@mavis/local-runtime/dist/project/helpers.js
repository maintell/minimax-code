import { projectDisplayName, workspaceDirFromProjectKey } from './canonical-workspace.js';
export function aggregateFromKey(key, state) {
    const workspaceDir = workspaceDirFromProjectKey(key);
    return {
        key,
        workspaceDir,
        sessions: [],
        allSessions: [],
        state,
    };
}
export function rootTaskSessions(sessions) {
    return sessions.filter((session) => !session.parentSessionId && session.sessionType === 'branch');
}
export function groupChildren(sessions) {
    const children = new Map();
    for (const session of sessions) {
        const parent = session.parentSessionId;
        if (!parent)
            continue;
        const list = children.get(parent) ?? [];
        list.push(session);
        children.set(parent, list);
    }
    for (const list of children.values())
        list.sort(compareSessions);
    return children;
}
export function compareProjects(left, right) {
    const leftPinned = left.state?.pinned === true;
    const rightPinned = right.state?.pinned === true;
    if (leftPinned !== rightPinned)
        return leftPinned ? -1 : 1;
    if (leftPinned && rightPinned) {
        const order = (left.state?.orderIndex ?? Number.MAX_SAFE_INTEGER) -
            (right.state?.orderIndex ?? Number.MAX_SAFE_INTEGER);
        if (order !== 0)
            return order;
    }
    const activity = (right.latestActivityAt ?? 0) - (left.latestActivityAt ?? 0);
    if (activity !== 0)
        return activity;
    return projectDisplayName(left.workspaceDir).localeCompare(projectDisplayName(right.workspaceDir));
}
export function compareSessions(left, right) {
    return (right.updatedAtMs - left.updatedAtMs ||
        right.createdAtMs - left.createdAtMs ||
        left.sessionId.localeCompare(right.sessionId));
}
/**
 * Slice `items` by an opaque string cursor and a page `limit`. `getCursor`
 * defaults to reading `ProjectAggregate.key` because that is the callsite in
 * `listProjects`; `listProjectSessions` passes a `session.sessionId` extractor
 * instead. Consumers get the next cursor only when the tail was truncated.
 */
export function paginate(items, cursor, limit, getCursor = (item) => item.key) {
    let result = items;
    if (cursor) {
        const cursorIndex = result.findIndex((item) => getCursor(item) === cursor);
        if (cursorIndex >= 0)
            result = result.slice(cursorIndex + 1);
    }
    const page = result.slice(0, limit);
    return {
        items: page,
        hasMore: result.length > limit,
        nextCursor: result.length > limit ? getCursor(page[page.length - 1]) : undefined,
    };
}
export function normalizePositiveInteger(value) {
    if (value === undefined || !Number.isFinite(value))
        return undefined;
    return Math.max(1, Math.floor(value));
}
//# sourceMappingURL=helpers.js.map