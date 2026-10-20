import { digestThreadGoalObjective } from '@mavis/goal';
export const THREAD_GOAL_KICKOFF_PREFIX = 'thread-goal-kickoff:';
export const THREAD_GOAL_KICKOFF_ORIGIN_TYPE = 'thread-goal-kickoff';
export const THREAD_GOAL_CONTINUATION_PREFIX = 'thread-goal-followup:';
export const THREAD_GOAL_CONTINUATION_ORIGIN_TYPE = 'thread-goal-continuation';
export function threadGoalKickoffClientRequestId(goalId) {
    return `${THREAD_GOAL_KICKOFF_PREFIX}${goalId}`;
}
export function threadGoalContinuationClientRequestId(turnId) {
    return `${THREAD_GOAL_CONTINUATION_PREFIX}${turnId}`;
}
export function threadGoalRecoveryClientRequestId(goal) {
    return threadGoalContinuationClientRequestId(`recovery:${goal.goalId}:${goal.updatedAt}`);
}
/**
 * Idempotency key for a re-armed follow-up, scoped to the Goal epoch it is
 * rebuilt at.
 *
 * A re-arm rebuilds from the settling Turn, so the default
 * `thread-goal-followup:<turnId>` key belongs to the epoch that was just
 * invalidated. Reusing it makes the Queue dedupe the new follow-up onto the
 * stale row, which is then cancelled for being stale — the Goal stops. Keying
 * by Goal id and epoch keeps retries of the same rebuild idempotent while a
 * genuinely new epoch gets its own admissible row.
 */
export function threadGoalRearmClientRequestId(goal) {
    return threadGoalContinuationClientRequestId(`rearm:${goal.goalId}:${goal.updatedAt}`);
}
/** Stable across restart; a later re-arm receives a new Goal epoch. */
export function threadGoalBudgetLimitClientRequestId(goal) {
    return threadGoalContinuationClientRequestId(`budget-limit:${goal.goalId}:${goal.updatedAt}`);
}
/** The worker proposal is stable even when verifier/summary usage advances the Goal epoch. */
export function threadGoalCompletionClientRequestId(goalId, proposalTurnId) {
    return threadGoalContinuationClientRequestId(`completion:${goalId}:${proposalTurnId}`);
}
export function buildThreadGoalKickoffMessage(goal, content, attachments = []) {
    return {
        content,
        attachments: [...attachments, ...(goal.objectiveResources ?? [])],
        source: 'thread-goal',
        origin: {
            type: THREAD_GOAL_KICKOFF_ORIGIN_TYPE,
            goalId: goal.goalId,
            goalUpdatedAt: goal.updatedAt,
            objectiveDigest: digestThreadGoalObjective(goal.objective),
            displayContent: goal.objective,
        },
    };
}
/**
 * Continuation turns intentionally carry no attachments: the kickoff message
 * already pushed objective resources once, and every later turn can pull them
 * on demand via `get_goal` (`objective_resources` file paths), which the
 * recovery prompt and the periodic terminal audit already instruct the worker
 * to call. Re-attaching screenshots here would resend every image on every
 * continuation turn.
 */
export function buildThreadGoalContinuationMessage(goal, content, kind) {
    return {
        content,
        // A pause may retire the initial Queue item before it ever starts. Keep its
        // inputs on the first resumed Goal turn, not on later turns or summaries.
        attachments: kind === 'active' && goal.turnsUsed === 0
            ? (goal.kickoffAttachments ?? []).map((attachment) => ({ ...attachment }))
            : [],
        origin: {
            type: THREAD_GOAL_CONTINUATION_ORIGIN_TYPE,
            goalId: goal.goalId,
            goalUpdatedAt: goal.updatedAt,
            objectiveDigest: digestThreadGoalObjective(goal.objective),
            kind,
        },
    };
}
export function readThreadGoalKickoffOrigin(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const record = value;
    if (record.type !== THREAD_GOAL_KICKOFF_ORIGIN_TYPE)
        return undefined;
    if (typeof record.goalId !== 'string' ||
        typeof record.displayContent !== 'string' ||
        typeof record.objectiveDigest !== 'string' ||
        !isUnixMs(record.goalUpdatedAt)) {
        return undefined;
    }
    return {
        type: THREAD_GOAL_KICKOFF_ORIGIN_TYPE,
        goalId: record.goalId,
        goalUpdatedAt: record.goalUpdatedAt,
        objectiveDigest: record.objectiveDigest,
        displayContent: record.displayContent,
    };
}
/**
 * Queue/UI compatibility for kickoff items persisted before admission metadata
 * was added. This intentionally does not make the strict reader above accept
 * an incomplete identity: old items remain fenced as Goal work, then fail
 * closed when the dispatcher asks for a trusted admission origin.
 */
export function readThreadGoalKickoffDisplayContent(value) {
    const record = readOriginRecord(value, THREAD_GOAL_KICKOFF_ORIGIN_TYPE);
    return typeof record?.displayContent === 'string' ? record.displayContent : undefined;
}
export function readThreadGoalContinuationOrigin(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const record = value;
    if (record.type !== THREAD_GOAL_CONTINUATION_ORIGIN_TYPE)
        return undefined;
    if (typeof record.goalId !== 'string' || record.goalId.length === 0)
        return undefined;
    if (!isUnixMs(record.goalUpdatedAt) || typeof record.objectiveDigest !== 'string') {
        return undefined;
    }
    if (record.kind !== 'active' &&
        record.kind !== 'budget-limit' &&
        record.kind !== 'completion-summary')
        return undefined;
    return {
        type: THREAD_GOAL_CONTINUATION_ORIGIN_TYPE,
        goalId: record.goalId,
        goalUpdatedAt: record.goalUpdatedAt,
        objectiveDigest: record.objectiveDigest,
        kind: record.kind,
    };
}
function isUnixMs(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
export function isThreadGoalKickoffQueueItem(item) {
    return (item.clientRequestId?.startsWith(THREAD_GOAL_KICKOFF_PREFIX) === true ||
        readOriginRecord(item.message.origin, THREAD_GOAL_KICKOFF_ORIGIN_TYPE) !== undefined);
}
export function isThreadGoalContinuationQueueItem(item) {
    return (item.clientRequestId?.startsWith(THREAD_GOAL_CONTINUATION_PREFIX) === true ||
        readOriginRecord(item.message.origin, THREAD_GOAL_CONTINUATION_ORIGIN_TYPE) !== undefined);
}
function readOriginRecord(value, type) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const record = value;
    return record.type === type ? record : undefined;
}
//# sourceMappingURL=kickoff.js.map