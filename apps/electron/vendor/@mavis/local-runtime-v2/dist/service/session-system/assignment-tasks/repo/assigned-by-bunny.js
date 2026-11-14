import { BUNNY_AGENT_NAME } from '@mavis/shared/agent-avatar';
import { eq, inArray, sql } from 'drizzle-orm';
import { bunnyAssignmentTasks } from '../../../../infra/db/schema/bunny-store.js';
import { sessions } from '../../../../infra/db/schema/sessions.js';
const ID_CHUNK = 500;
/**
 * The one definition of "Bunny assigned this task": the task graph records
 * Bunny as its assigner. Ownership of whole Session trees (Bunny's own
 * Sessions, its Cron runs and their descendants) is a different question.
 */
export function isAssignedByBunny(assignment) {
    return assignment?.assignerAgentName === BUNNY_AGENT_NAME;
}
/**
 * Sessions whose task Bunny assigned, read from the Bunny store. Not filtered by
 * Session existence: shared-database queries match them against live rows.
 */
export function readBunnyAssignedSessionIds(db) {
    return db
        .select({ sessionId: bunnyAssignmentTasks.sessionId })
        .from(bunnyAssignmentTasks)
        .where(eq(bunnyAssignmentTasks.assignerAgentName, BUNNY_AGENT_NAME))
        .all()
        .map((row) => row.sessionId);
}
/** Assigner agent per Session that has a task; every task when `sessionIds` is omitted. */
export function readAssignerBySession(db, sessionIds) {
    const select = (ids) => db
        .select({
        sessionId: bunnyAssignmentTasks.sessionId,
        assigner: bunnyAssignmentTasks.assignerAgentName,
    })
        .from(bunnyAssignmentTasks)
        .where(ids ? inArray(bunnyAssignmentTasks.sessionId, ids) : undefined)
        .all();
    const unique = sessionIds ? [...new Set(sessionIds)] : undefined;
    const rows = unique
        ? Array.from({ length: Math.ceil(unique.length / ID_CHUNK) }, (_, index) => select(unique.slice(index * ID_CHUNK, (index + 1) * ID_CHUNK))).flat()
        : select();
    return new Map(rows.map((row) => [row.sessionId, row.assigner]));
}
/**
 * {@link isAssignedByBunny} for shared-database queries over `sessions`. Tasks
 * live in the Bunny store, a different SQLite file, so the caller reads the
 * assigned ids there ({@link readBunnyAssignedSessionIds}) and hands them over
 * as one JSON array parameter.
 */
export function assignedByBunnyCondition(bunnyAssignedSessionIds) {
    return sql `${sessions.sessionId} in (select value from json_each(${JSON.stringify(bunnyAssignedSessionIds)}))`;
}
//# sourceMappingURL=assigned-by-bunny.js.map