import { AssignmentCursorError, } from './contracts.js';
/**
 * Reading back the work a coordinator Session dispatched.
 *
 * Split out of `assignment.service.ts` so that file stays inside the local runtime layout
 * budget. The reads are pure: they take the task and Session stores and return what the
 * terminal lists, so nothing here owns service state.
 */
/** The coordinator Session that dispatched this one, or `undefined` when it runs no task. */
export async function assignerSessionOf(tasks, sessionId) {
    return (await tasks.get(sessionId))?.assignerSessionId;
}
/**
 * Every task these assigner Sessions dispatched, open first and newest assigned first, so a
 * bounded list never drops an open task for a newer closed one.
 *
 * Scoped by assigner Session rather than by Agent name: every Bunny conversation shares one
 * assigner Agent, so an Agent-scoped read would hand a reader the whole machine's work
 * instead of its own.
 */
export async function listDispatchedTasks(stores, assignerSessionIds, limit = 200) {
    assertTaskLimit(limit);
    const ids = [...new Set(assignerSessionIds)];
    if (ids.length === 0 || limit === 0)
        return [];
    const assigned = sortTasksByDispatchOrder(await stores.tasks.list({ assignerSessionId: ids })).slice(0, limit);
    const sessions = await Promise.all(assigned.map(({ sessionId }) => stores.sessions.get(sessionId)));
    return assigned.flatMap(({ sessionId, assignment }, index) => {
        const session = sessions[index];
        const completionState = toCompletionState(assignment.completion);
        return session
            ? [
                {
                    sessionId,
                    assignerSessionId: assignment.assignerSessionId,
                    session,
                    ...(completionState ? { completionState } : {}),
                },
            ]
            : [];
    });
}
/** The order key of one task. */
function taskOrder(task) {
    return {
        closed: Boolean(task.assignment.completion),
        at: task.assignment.assignedAt,
        id: task.sessionId,
    };
}
/**
 * The one task order: unfinished before finished, then newest dispatch first, then session id.
 *
 * The id tiebreak is what lets a page cursor resume exactly where the previous page stopped, so
 * every reader has to agree on it. The overview list, the CLI list and the paged read all sort
 * through this; a second copy of the rule is how they silently drift apart.
 */
function compareTaskOrder(a, b) {
    const closed = Number(a.closed) - Number(b.closed);
    if (closed)
        return closed;
    const at = b.at - a.at;
    if (at)
        return at;
    if (a.id === b.id)
        return 0;
    return a.id < b.id ? -1 : 1;
}
/** Sorts tasks into the shared order, leaving the caller's array alone. */
export function sortTasksByDispatchOrder(tasks) {
    return [...tasks].sort((a, b) => compareTaskOrder(taskOrder(a), taskOrder(b)));
}
/** One limit rule for every task reader; the HTTP entry maps this to 400. */
export function assertTaskLimit(limit) {
    if (!Number.isSafeInteger(limit) || limit < 0)
        throw new AssignmentCursorError('Invalid assignment limit');
}
function toCompletionState(completion) {
    if (!completion)
        return undefined;
    if (completion.reason === 'stalled')
        return 'failed';
    if (completion.state === 'cancelled' || completion.state === 'taken_over')
        return 'stopped';
    return 'completed';
}
function decodeCursor(value, agent, item) {
    try {
        const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
        if (!cursor ||
            cursor.agent !== agent ||
            cursor.item !== item ||
            typeof cursor.closed !== 'boolean' ||
            !Number.isFinite(cursor.at) ||
            typeof cursor.id !== 'string')
            throw new Error();
        return cursor;
    }
    catch {
        throw new AssignmentCursorError('Invalid assignment cursor');
    }
}
function countWorklineTasks(tasks, links) {
    const counts = Object.create(null);
    for (const task of tasks) {
        const id = links.get(task.sessionId);
        if (id)
            counts[id] = (counts[id] ?? 0) + 1;
    }
    return counts;
}
/** Select metadata first; only this page needs session status and artifact reads. */
function assignmentPage(tasks, links, agent, input) {
    const limit = input.limit ?? 50;
    assertTaskLimit(limit);
    const cursor = input.cursor ? decodeCursor(input.cursor, agent, input.worklineId) : undefined;
    const worklineCounts = countWorklineTasks(tasks, links);
    const scoped = sortTasksByDispatchOrder(tasks.filter((task) => input.worklineId === undefined || links.get(task.sessionId) === input.worklineId));
    const remaining = cursor
        ? scoped.filter((task) => compareTaskOrder(taskOrder(task), cursor) > 0)
        : scoped;
    const selected = remaining.slice(0, limit);
    const hasMore = limit > 0 && remaining.length > selected.length;
    const last = selected.at(-1);
    return {
        selected,
        worklineCounts,
        totalCount: scoped.length,
        hasMore,
        ...(hasMore && last
            ? {
                nextCursor: Buffer.from(JSON.stringify({ agent, item: input.worklineId, ...taskOrder(last) })).toString('base64url'),
            }
            : {}),
    };
}
export async function listAssignmentPage(options, agent, input, status) {
    const { selected, ...page } = assignmentPage(await options.tasks.list({ archived: false, assignerAgentName: agent }), options.worklines.sessionSpaces(), agent, input);
    const statuses = await Promise.all(selected.map(async ({ sessionId, assignment }) => {
        const session = await options.sessions.get(sessionId);
        return session && !session.archived ? status(session, assignment) : undefined;
    }));
    return {
        ...page,
        assignments: statuses.filter((item) => item !== undefined),
    };
}
//# sourceMappingURL=dispatched-tasks.js.map