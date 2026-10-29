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
    const currentLimit = () => parseSubagentConfig({
        maxConcurrentPerSession: options.readMaxConcurrentPerSession?.(),
    }).maxConcurrentPerSession;
    const readOccupancy = (db, parentSessionId) => {
        const activeChildSessionIds = options.tasks.taskChildIdsForCandidatesInTransaction(db, {
            parentSessionId,
            candidateSessionIds: executionSessionIdsInTransaction(db),
        });
        return { active: activeChildSessionIds.length, limit: currentLimit(), activeChildSessionIds };
    };
    return {
        admissionPolicy: {
            applyInTransaction(db, input) {
                const parentSessionId = options.tasks.taskParentIdInTransaction(db, input.sessionId);
                if (!parentSessionId)
                    return undefined;
                const occupancy = readOccupancy(db, parentSessionId);
                if (occupancy.active < occupancy.limit)
                    return undefined;
                // Every entry (task, task_append, session send, queue dispatch) is
                // rejected here, so this records which children held the slots.
                logAdmissionRejected(options.logger, input.sessionId, parentSessionId, occupancy);
                return DESKTOP_SUBAGENT_CONCURRENCY_REJECTION;
            },
        },
        occupancy: (parentSessionId) => readOccupancy(options.db, parentSessionId),
        wakeQueuedSiblings: async ({ releasedSessionId, queue, dispatch }) => {
            const pendingSessionIds = await queue.listPendingSessionIds();
            const siblingSessionIds = await options.tasks.taskSiblingIdsForCandidates(releasedSessionId, pendingSessionIds);
            if (siblingSessionIds.length === 0)
                return;
            await Promise.allSettled(siblingSessionIds.map((sessionId) => dispatch(sessionId)));
        },
        recoverQueuedTaskChildren: async ({ queue, dispatch, recoverTaskOwners, signal }) => {
            const aborted = () => signal?.aborted === true;
            const pendingSessionIds = await queue.listPendingSessionIds();
            if (aborted())
                return false;
            const taskChildren = await options.tasks.taskChildrenForCandidates(pendingSessionIds);
            if (taskChildren.length === 0 || aborted())
                return false;
            const parentSessionIds = new Set(taskChildren.map((child) => child.parentSessionId));
            const executingTaskChildren = await options.tasks.taskChildrenForCandidates(executionSessionIdsInTransaction(options.db));
            const staleOwnerSessionIds = executingTaskChildren
                .filter((child) => parentSessionIds.has(child.parentSessionId))
                .map((child) => child.sessionId);
            await recoverTaskOwners?.(staleOwnerSessionIds);
            if (aborted())
                return false;
            await Promise.allSettled(taskChildren.map(({ sessionId }) => dispatch(sessionId)));
            if (aborted())
                return false;
            const remainingSessionIds = await queue.listPendingSessionIds();
            return (await options.tasks.taskChildrenForCandidates(remainingSessionIds)).length > 0;
        },
    };
}
function logAdmissionRejected(logger, sessionId, parentSessionId, occupancy) {
    try {
        logger?.info({
            sessionId,
            parentSessionId,
            active: occupancy.active,
            limit: occupancy.limit,
            activeChildSessionIds: occupancy.activeChildSessionIds,
        }, 'subagent_concurrency_admission_rejected');
    }
    catch {
        // Runs inside the admission transaction; a logging failure must not abort it.
    }
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