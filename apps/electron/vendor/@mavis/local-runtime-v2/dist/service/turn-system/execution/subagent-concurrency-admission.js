import { parseSubagentConfig, SUBAGENT_CONFIG_DEFAULTS } from '@mavis/config';
import { inArray } from 'drizzle-orm';
import { sessionLocks } from '../../../infra/db/schema/turn.js';
import { COMPACTION_DELETING_OWNER_KIND, TURN_DELETING_OWNER_KIND, } from '../persistence/turn-lease-recovery.js';
export const DESKTOP_SUBAGENT_CONCURRENCY_LIMIT = SUBAGENT_CONFIG_DEFAULTS.maxConcurrentPerSession;
export const DESKTOP_SUBAGENT_CONCURRENCY_REJECTION = 'policy:subagent:concurrency-limit';
/**
 * Durable execution owners that keep a Task child executing until exact Turn
 * settlement. Legacy send/dispatcher owners remain conservative occupants
 * while the existing process-restart recovery decides whether they are live.
 */
const TASK_EXECUTION_OWNER_KINDS = [
    'turn',
    'compaction',
    'send',
    'dispatcher',
    TURN_DELETING_OWNER_KIND,
    COMPACTION_DELETING_OWNER_KIND,
];
/**
 * Desktop-only composition supplies this policy to the shared Turn admission
 * transaction. There is intentionally no process-local occupancy counter.
 */
export function createDesktopSubagentConcurrency(options) {
    const { maxConcurrentPerSession } = parseSubagentConfig({
        maxConcurrentPerSession: options.maxConcurrentPerSession,
    });
    return {
        admissionPolicy: {
            applyInTransaction(db, input) {
                const parentSessionId = options.tasks.taskParentIdInTransaction(db, input.sessionId);
                if (!parentSessionId)
                    return undefined;
                const executionSessionIds = executionSessionIdsInTransaction(db);
                const activeChildIds = options.tasks.taskChildIdsForCandidatesInTransaction(db, {
                    parentSessionId,
                    candidateSessionIds: executionSessionIds,
                });
                return activeChildIds.length >= maxConcurrentPerSession
                    ? DESKTOP_SUBAGENT_CONCURRENCY_REJECTION
                    : undefined;
            },
        },
        wakeQueuedSiblings: async ({ releasedSessionId, queue, dispatch }) => {
            const pendingSessionIds = await queue.listPendingSessionIds();
            const siblingSessionIds = await options.tasks.taskSiblingIdsForCandidates(releasedSessionId, pendingSessionIds);
            if (siblingSessionIds.length === 0)
                return;
            await Promise.allSettled(siblingSessionIds.map((sessionId) => dispatch(sessionId)));
        },
        recoverQueuedTaskChildren: async ({ queue, dispatch, recoverTaskOwners }) => {
            const pendingSessionIds = await queue.listPendingSessionIds();
            const taskChildren = await options.tasks.taskChildrenForCandidates(pendingSessionIds);
            if (taskChildren.length === 0)
                return false;
            const parentSessionIds = new Set(taskChildren.map((child) => child.parentSessionId));
            const executingTaskChildren = await options.tasks.taskChildrenForCandidates(executionSessionIdsInTransaction(options.db));
            const staleOwnerSessionIds = executingTaskChildren
                .filter((child) => parentSessionIds.has(child.parentSessionId))
                .map((child) => child.sessionId);
            await recoverTaskOwners?.(staleOwnerSessionIds);
            await Promise.allSettled(taskChildren.map(({ sessionId }) => dispatch(sessionId)));
            const remainingSessionIds = await queue.listPendingSessionIds();
            return (await options.tasks.taskChildrenForCandidates(remainingSessionIds)).length > 0;
        },
    };
}
function executionSessionIdsInTransaction(db) {
    return db
        .select({ sessionId: sessionLocks.sessionId })
        .from(sessionLocks)
        .where(inArray(sessionLocks.ownerKind, [...TASK_EXECUTION_OWNER_KINDS]))
        .all()
        .map((lock) => lock.sessionId);
}
//# sourceMappingURL=subagent-concurrency-admission.js.map