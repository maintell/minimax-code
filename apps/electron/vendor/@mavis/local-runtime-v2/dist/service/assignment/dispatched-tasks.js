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
    if (!Number.isSafeInteger(limit) || limit < 0)
        throw new Error('limit must be a non-negative integer');
    const ids = [...new Set(assignerSessionIds)];
    if (ids.length === 0 || limit === 0)
        return [];
    const assigned = [...(await stores.tasks.list({ assignerSessionId: ids }))]
        .sort((a, b) => Number(Boolean(a.assignment.completion)) - Number(Boolean(b.assignment.completion)) ||
        b.assignment.assignedAt - a.assignment.assignedAt)
        .slice(0, limit);
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
function toCompletionState(completion) {
    if (!completion)
        return undefined;
    if (completion.reason === 'stalled')
        return 'failed';
    if (completion.state === 'cancelled' || completion.state === 'taken_over')
        return 'stopped';
    return 'completed';
}
//# sourceMappingURL=dispatched-tasks.js.map