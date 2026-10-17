import { and, eq, inArray } from 'drizzle-orm';
import { sessions } from '../../../infra/db/schema/sessions.js';
import { decodeSessionRow } from './repo/drizzle/codec.js';
import { isTaskSession } from './repo/drizzle/normalization.js';
export function createTaskExecutionAdmissionCapability(options) {
    const taskParentIdInTransaction = (db, sessionId) => {
        const row = db
            .select()
            .from(sessions)
            .where(and(eq(sessions.sessionId, sessionId), eq(sessions.columnarVersion, 3)))
            .get();
        if (!row)
            return undefined;
        const session = decodeSessionRow(row);
        return isTaskSession(session) ? (session.parentSessionId ?? undefined) : undefined;
    };
    const taskChildrenForCandidatesInTransaction = (db, candidateSessionIds) => {
        const candidateIds = [...new Set(candidateSessionIds)];
        const matching = [];
        for (const ids of chunks(candidateIds, SQLITE_BINDING_BATCH_SIZE)) {
            const rows = db
                .select()
                .from(sessions)
                .where(and(eq(sessions.columnarVersion, 3), inArray(sessions.sessionId, ids)))
                .all()
                .map(decodeSessionRow);
            for (const session of rows) {
                if (!isTaskSession(session) || !session.parentSessionId)
                    continue;
                matching.push({ sessionId: session.sessionId, parentSessionId: session.parentSessionId });
            }
        }
        return matching;
    };
    const taskChildIdsForCandidatesInTransaction = (db, input) => {
        return taskChildrenForCandidatesInTransaction(db, input.candidateSessionIds)
            .filter((child) => child.parentSessionId === input.parentSessionId)
            .map((child) => child.sessionId);
    };
    return {
        taskParentIdInTransaction,
        taskChildrenForCandidatesInTransaction,
        taskChildrenForCandidates: async (candidateSessionIds) => taskChildrenForCandidatesInTransaction(options.db, candidateSessionIds),
        taskChildIdsForCandidatesInTransaction,
        taskSiblingIdsForCandidates: async (sessionId, candidateSessionIds) => {
            const parentSessionId = taskParentIdInTransaction(options.db, sessionId);
            if (!parentSessionId)
                return [];
            return taskChildIdsForCandidatesInTransaction(options.db, {
                parentSessionId,
                candidateSessionIds,
            }).filter((candidateSessionId) => candidateSessionId !== sessionId);
        },
    };
}
const SQLITE_BINDING_BATCH_SIZE = 500;
function* chunks(values, size) {
    for (let start = 0; start < values.length; start += size) {
        yield values.slice(start, start + size);
    }
}
//# sourceMappingURL=task-execution-admission.js.map