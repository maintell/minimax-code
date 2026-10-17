import { and, asc, desc, eq, gt, inArray, lt, or } from 'drizzle-orm';
import { memoryExecutionCalls as calls, memoryExecutionTasks as tasks, } from '../../../infra/db/schema/memory-executions.js';
const tokenKeys = [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'totalTokens',
];
function missingUsage(call) {
    return tokenKeys.some((key) => call[key] === null);
}
function aggregate(rows) {
    const sum = (key) => {
        const known = rows.flatMap((row) => (row[key] === null ? [] : [row[key]]));
        return rows.length > 0 && known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
    };
    const missingUsageCount = rows.filter(missingUsage).length;
    return {
        requestCount: rows.length,
        finishedCount: rows.filter((row) => row.finishedAtMs !== null).length,
        missingUsageCount,
        incomplete: missingUsageCount > 0,
        inputTokens: sum('inputTokens'),
        outputTokens: sum('outputTokens'),
        cacheReadTokens: sum('cacheReadTokens'),
        cacheWriteTokens: sum('cacheWriteTokens'),
        totalTokens: sum('totalTokens'),
    };
}
export function createMemoryExecutionQuery(db) {
    const readCalls = (taskIds) => db.select().from(calls).where(inArray(calls.taskId, taskIds)).orderBy(asc(calls.ordinal)).all();
    return {
        listTasks(input = {}) {
            const limit = validateQuery(input);
            const rows = db
                .select()
                .from(tasks)
                .where(queryPredicate(input))
                .orderBy(desc(tasks.startedAtMs), desc(tasks.taskId))
                .limit(limit + 1)
                .all();
            const page = rows.slice(0, limit);
            const records = page.length ? readCalls(page.map((row) => row.taskId)) : [];
            const last = page.at(-1);
            return {
                tasks: page.map((row) => ({
                    ...row,
                    missingCompletion: row.finishedAtMs === null,
                    usage: aggregate(records.filter((call) => call.taskId === row.taskId)),
                })),
                ...(rows.length > limit && last
                    ? { nextCursor: { startedAtMs: last.startedAtMs, taskId: last.taskId } }
                    : {}),
            };
        },
        getTask(taskId) {
            const row = db.select().from(tasks).where(eq(tasks.taskId, taskId)).get();
            if (!row)
                return null;
            const records = readCalls([taskId]);
            return {
                ...row,
                missingCompletion: row.finishedAtMs === null,
                usage: aggregate(records),
                calls: records.map((call) => ({ ...call, missingUsage: missingUsage(call) })),
            };
        },
    };
}
function validateQuery(input) {
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
        throw new Error('invalid-execution-query-limit');
    if (input.stage && !['migration', 'capture', 'consolidation'].includes(input.stage))
        throw new Error('invalid-execution-query-stage');
    validateTime(input.startedAfterMs);
    validateTime(input.before?.startedAtMs);
    if (input.before && !input.before.taskId)
        throw new Error('invalid-execution-query-cursor');
    return limit;
}
function queryPredicate(input) {
    return and(input.stage ? eq(tasks.stage, input.stage) : undefined, input.sourceRef ? eq(tasks.sourceRef, input.sourceRef) : undefined, input.startedAfterMs === undefined ? undefined : gt(tasks.startedAtMs, input.startedAfterMs), input.before
        ? or(lt(tasks.startedAtMs, input.before.startedAtMs), and(eq(tasks.startedAtMs, input.before.startedAtMs), lt(tasks.taskId, input.before.taskId)))
        : undefined);
}
function validateTime(value) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
        throw new Error('invalid-execution-query-time');
}
//# sourceMappingURL=query.js.map