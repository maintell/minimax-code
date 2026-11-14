import { and, eq, inArray, isNull } from 'drizzle-orm';
import { cronDefinitions, cronRuns } from '../../infra/db/schema/cron.js';
import { schedulerJobs } from '../../infra/db/schema/scheduler.js';
/** Rows per insert statement, well below SQLite's bound-variable limit. */
const CHUNK = 100;
export function createAgentRoutines(options) {
    const { db, agentName, create, remove } = options;
    const owned = eq(cronDefinitions.agentName, agentName);
    return {
        snapshot: () => {
            const routines = db.select().from(cronDefinitions).where(owned).all();
            const ids = routines.map((row) => row.cronId);
            return {
                routines,
                routineSchedules: routines.length
                    ? db
                        .select()
                        .from(schedulerJobs)
                        .where(inArray(schedulerJobs.schedulerId, routines.map((row) => row.schedulerId)))
                        .all()
                    : [],
                runs: ids.length
                    ? db.select().from(cronRuns).where(inArray(cronRuns.cronId, ids)).all()
                    : [],
            };
        },
        liveIds: () => db
            .select({ cronId: cronDefinitions.cronId })
            .from(cronDefinitions)
            .where(and(owned, isNull(cronDefinitions.deletedAtMs)))
            .all()
            .map((row) => row.cronId),
        delete: async (cronIds) => {
            if (!remove)
                return 0;
            for (const cronId of cronIds)
                await remove(cronId);
            return cronIds.length;
        },
        clear: (tx) => {
            const routines = tx.select().from(cronDefinitions).where(owned).all();
            const ids = routines.map((row) => row.cronId);
            if (!ids.length)
                return;
            tx.delete(cronRuns).where(inArray(cronRuns.cronId, ids)).run();
            tx.delete(cronDefinitions).where(inArray(cronDefinitions.cronId, ids)).run();
            tx.delete(schedulerJobs)
                .where(inArray(schedulerJobs.schedulerId, routines.map((row) => row.schedulerId)))
                .run();
        },
        restore: async (rows, nowMs) => {
            const skippedRoutines = [];
            for (const routine of rows.routines ?? []) {
                if (routine.deletedAtMs !== null)
                    continue;
                if (!(await restoreRoutine(db, rows, routine, { create, nowMs })))
                    skippedRoutines.push(routine.name);
            }
            return { skippedRoutines };
        },
    };
}
/** Recreates one routine and its finished runs; false when it could not be recreated. */
async function restoreRoutine(db, rows, routine, { create, nowMs, }) {
    const job = rows.routineSchedules?.find((row) => row.schedulerId === routine.schedulerId);
    if (!create || !job)
        return false;
    let cronId;
    try {
        ({ cronId } = await create(routineCommand(routine, job, nowMs)));
    }
    catch {
        return false;
    }
    const runs = (rows.runs ?? [])
        .filter((run) => run.cronId === routine.cronId && run.status !== 'pending')
        .map((run) => ({ ...run, cronId }));
    for (let start = 0; start < runs.length; start += CHUNK)
        db.insert(cronRuns)
            .values(runs.slice(start, start + CHUNK))
            .onConflictDoNothing()
            .run();
    return true;
}
/**
 * The create command for a backed-up routine. A recurring schedule keeps only the runs it
 * had left; a one-shot time that passed while the backup waited comes back disabled
 * instead of firing at once.
 */
function routineCommand(routine, job, nowMs) {
    const stored = job.scheduleJson;
    const schedule = stored.kind === 'once'
        ? { kind: 'once', runAtMs: stored.runAtMs }
        : {
            kind: 'recurring',
            expression: stored.expression,
            ...(stored.timezone === undefined ? {} : { timezone: stored.timezone }),
            ...(stored.maxRuns === undefined
                ? {}
                : { maxRuns: Math.max(1, stored.maxRuns - job.runCount) }),
        };
    const due = schedule.kind === 'once' && schedule.runAtMs <= nowMs;
    return {
        name: routine.name,
        agentName: routine.agentName,
        prompt: routine.prompt,
        schedule,
        enabled: job.state === 'active' && !due,
        sessionTarget: routine.sessionTargetMode === 'sessionId'
            ? {
                mode: 'sessionId',
                ...(routine.targetSessionId ? { sessionId: routine.targetSessionId } : {}),
            }
            : { mode: 'new' },
        project: routine.project,
        model: routine.model,
    };
}
//# sourceMappingURL=agent-routines.js.map