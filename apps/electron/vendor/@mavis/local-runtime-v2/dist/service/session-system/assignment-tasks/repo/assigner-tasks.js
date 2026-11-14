import { and, count, eq, inArray } from 'drizzle-orm';
import { bunnyAssignmentTaskEvents, bunnyAssignmentTasks, } from '../../../../infra/db/schema/bunny-store.js';
export function createAssignerTasks(bunny, assignerAgentName) {
    const assigned = eq(bunnyAssignmentTasks.assignerAgentName, assignerAgentName);
    return {
        sessionIds: (among) => bunny
            .select({ sessionId: bunnyAssignmentTasks.sessionId })
            .from(bunnyAssignmentTasks)
            .where(among ? and(assigned, inArray(bunnyAssignmentTasks.sessionId, [...among])) : assigned)
            .all()
            .map((row) => row.sessionId),
        eventCount: (db = bunny) => {
            const tasks = db
                .select({ taskId: bunnyAssignmentTasks.taskId })
                .from(bunnyAssignmentTasks)
                .where(assigned);
            return (db
                .select({ value: count() })
                .from(bunnyAssignmentTaskEvents)
                .where(inArray(bunnyAssignmentTaskEvents.taskId, tasks))
                .get()?.value ?? 0);
        },
        clear: (tx) => tx.delete(bunnyAssignmentTasks).where(assigned).run().changes,
        clearSessions: (tx, sessionIds) => {
            const taskIds = sessionIds.length
                ? tx
                    .select({ taskId: bunnyAssignmentTasks.taskId })
                    .from(bunnyAssignmentTasks)
                    .where(and(assigned, inArray(bunnyAssignmentTasks.sessionId, [...sessionIds])))
                    .all()
                    .map((row) => row.taskId)
                : [];
            if (!taskIds.length)
                return { tasks: 0, events: 0 };
            const events = tx
                .select({ value: count() })
                .from(bunnyAssignmentTaskEvents)
                .where(inArray(bunnyAssignmentTaskEvents.taskId, taskIds))
                .get()?.value ?? 0;
            const tasks = tx
                .delete(bunnyAssignmentTasks)
                .where(inArray(bunnyAssignmentTasks.taskId, taskIds))
                .run().changes;
            return { tasks, events };
        },
    };
}
//# sourceMappingURL=assigner-tasks.js.map