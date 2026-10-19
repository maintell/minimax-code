import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { queryCollapseViewStates } from '../../infra/db/schema/query-collapse.js';
/**
 * Query display sidecar with Turn fencing. It deliberately does not own Turn
 * admission or execution: currentTurnId only prevents stale lifecycle writes.
 */
export function createQueryCollapseState(options) {
    const nowMs = options.nowMs ?? Date.now;
    return {
        start: async (input) => {
            const now = nowMs();
            options.db
                .insert(queryCollapseViewStates)
                .values({
                sessionId: input.sessionId,
                queryKey: input.queryKey,
                currentTurnId: input.currentTurnId,
                forceExpanded: 0,
                processingStartedAtMs: now,
                processingFinishedAtMs: null,
                updatedAtMs: now,
            })
                .onConflictDoUpdate({
                target: [queryCollapseViewStates.sessionId, queryCollapseViewStates.queryKey],
                set: {
                    currentTurnId: input.currentTurnId,
                    forceExpanded: 0,
                    processingStartedAtMs: sql `CASE
              WHEN ${queryCollapseViewStates.processingFinishedAtMs} IS NULL
              THEN ${queryCollapseViewStates.processingStartedAtMs}
              WHEN ${queryCollapseViewStates.processingFinishedAtMs} >= ${queryCollapseViewStates.processingStartedAtMs}
              THEN ${now} - (
                ${queryCollapseViewStates.processingFinishedAtMs} -
                ${queryCollapseViewStates.processingStartedAtMs}
              )
              ELSE ${now}
            END`,
                    processingFinishedAtMs: null,
                    updatedAtMs: now,
                },
            })
                .run();
            const state = readByKey(options.db, input.sessionId, input.queryKey);
            if (!state) {
                throw new Error(`Query collapse state missing: ${input.sessionId}/${input.queryKey}`);
            }
            return toState(state);
        },
        finish: async (input) => {
            const now = nowMs();
            const result = options.db
                .update(queryCollapseViewStates)
                .set({
                forceExpanded: sql `CASE
            WHEN ${queryCollapseViewStates.forceExpanded} = 1 OR ${input.forceExpanded ? 1 : 0} = 1
            THEN 1 ELSE 0 END`,
                processingFinishedAtMs: now,
                updatedAtMs: now,
            })
                .where(and(eq(queryCollapseViewStates.sessionId, input.sessionId), eq(queryCollapseViewStates.queryKey, input.queryKey), eq(queryCollapseViewStates.currentTurnId, input.currentTurnId), isNull(queryCollapseViewStates.processingFinishedAtMs)))
                .run();
            if (result.changes === 0)
                return undefined;
            const state = readByKey(options.db, input.sessionId, input.queryKey);
            return state ? toState(state) : undefined;
        },
        findByCurrentTurn: async (sessionId, currentTurnId) => {
            const state = options.db
                .select()
                .from(queryCollapseViewStates)
                .where(and(eq(queryCollapseViewStates.sessionId, sessionId), eq(queryCollapseViewStates.currentTurnId, currentTurnId)))
                .orderBy(desc(queryCollapseViewStates.updatedAtMs), desc(queryCollapseViewStates.queryKey))
                .get();
            return state ? toState(state) : undefined;
        },
        findProcessingByCurrentTurn: async (sessionId, currentTurnId) => {
            const state = readProcessingByCurrentTurn(options.db, sessionId, currentTurnId);
            return state ? toState(state) : undefined;
        },
        findByKey: async (sessionId, queryKey) => {
            const state = readByKey(options.db, sessionId, queryKey);
            return state ? toState(state) : undefined;
        },
        listByKeys: async (input) => readByKeys(options.db, input),
        list: async (sessionId) => options.db
            .select()
            .from(queryCollapseViewStates)
            .where(eq(queryCollapseViewStates.sessionId, sessionId))
            .orderBy(asc(queryCollapseViewStates.processingStartedAtMs), asc(queryCollapseViewStates.queryKey))
            .all()
            .map(toState),
        forceExpandForTurn: async (sessionId, currentTurnId) => {
            const now = nowMs();
            const result = options.db
                .update(queryCollapseViewStates)
                .set({ forceExpanded: 1, updatedAtMs: now })
                .where(and(eq(queryCollapseViewStates.sessionId, sessionId), eq(queryCollapseViewStates.currentTurnId, currentTurnId)))
                .run();
            if (result.changes === 0)
                return undefined;
            const state = readByCurrentTurn(options.db, sessionId, currentTurnId);
            return state ? toState(state) : undefined;
        },
        recoverUnfinished: async () => {
            const unfinished = options.db
                .select()
                .from(queryCollapseViewStates)
                .where(isNull(queryCollapseViewStates.processingFinishedAtMs))
                .all();
            if (unfinished.length === 0)
                return [];
            const now = nowMs();
            options.db
                .update(queryCollapseViewStates)
                .set({ forceExpanded: 1, processingFinishedAtMs: now, updatedAtMs: now })
                .where(isNull(queryCollapseViewStates.processingFinishedAtMs))
                .run();
            return unfinished.map((state) => toState({
                ...state,
                forceExpanded: 1,
                processingFinishedAtMs: now,
                updatedAtMs: now,
            }));
        },
        deleteSession: async (sessionId) => {
            options.db
                .delete(queryCollapseViewStates)
                .where(eq(queryCollapseViewStates.sessionId, sessionId))
                .run();
        },
    };
}
function readByCurrentTurn(db, sessionId, currentTurnId) {
    return db
        .select()
        .from(queryCollapseViewStates)
        .where(and(eq(queryCollapseViewStates.sessionId, sessionId), eq(queryCollapseViewStates.currentTurnId, currentTurnId)))
        .orderBy(desc(queryCollapseViewStates.updatedAtMs), desc(queryCollapseViewStates.queryKey))
        .get();
}
const processingQueries = new WeakMap();
function readProcessingByCurrentTurn(db, sessionId, currentTurnId) {
    let query = processingQueries.get(db);
    if (!query) {
        query = prepareProcessingQuery(db);
        processingQueries.set(db, query);
    }
    return query.get({ sessionId, currentTurnId });
}
function prepareProcessingQuery(db) {
    return db
        .select()
        .from(queryCollapseViewStates)
        .where(and(eq(queryCollapseViewStates.sessionId, sql.placeholder('sessionId')), eq(queryCollapseViewStates.currentTurnId, sql.placeholder('currentTurnId')), isNull(queryCollapseViewStates.processingFinishedAtMs)))
        .orderBy(desc(queryCollapseViewStates.updatedAtMs), desc(queryCollapseViewStates.queryKey))
        .prepare();
}
function readByKey(db, sessionId, queryKey) {
    return db
        .select()
        .from(queryCollapseViewStates)
        .where(and(eq(queryCollapseViewStates.sessionId, sessionId), eq(queryCollapseViewStates.queryKey, queryKey)))
        .get();
}
function readByKeys(db, input) {
    const queryKeys = [...new Set(input.queryKeys.filter((queryKey) => queryKey.length > 0))];
    if (queryKeys.length === 0)
        return [];
    const states = db
        .select()
        .from(queryCollapseViewStates)
        .where(and(eq(queryCollapseViewStates.sessionId, input.sessionId), inArray(queryCollapseViewStates.queryKey, queryKeys)))
        .all();
    const statesByKey = new Map(states.map((state) => [state.queryKey, state]));
    return queryKeys.flatMap((queryKey) => {
        const state = statesByKey.get(queryKey);
        return state ? [toState(state)] : [];
    });
}
function toState(row) {
    return {
        sessionId: row.sessionId,
        queryKey: row.queryKey,
        currentTurnId: row.currentTurnId,
        forceExpanded: row.forceExpanded === 1,
        processingStartedAtMs: row.processingStartedAtMs,
        ...(row.processingFinishedAtMs === null
            ? {}
            : { processingFinishedAtMs: row.processingFinishedAtMs }),
        updatedAtMs: row.updatedAtMs,
    };
}
//# sourceMappingURL=query-collapse-state.js.map