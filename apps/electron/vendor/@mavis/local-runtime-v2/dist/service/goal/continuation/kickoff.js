import { THREAD_GOAL_KICKOFF_ORIGIN_TYPE, THREAD_GOAL_KICKOFF_PREFIX, digestThreadGoalObjective, readThreadGoalKickoffOriginRecord, } from '@mavis/goal';
const THREAD_GOAL_CONTINUATION_PREFIX = 'thread-goal-followup:';
const THREAD_GOAL_CONTINUATION_ORIGIN_TYPE = 'thread-goal-continuation';
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
/**
 * Idempotency key the pre-upgrade runtime gave a budget-summary item. Only
 * startup retirement uses it, to find such an item and cancel it.
 */
export function threadGoalLegacyBudgetLimitClientRequestId(goal) {
    return threadGoalContinuationClientRequestId(`budget-limit:${goal.goalId}:${goal.updatedAt}`);
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
 * Continuation turns carry no attachments: the kickoff message already pushed
 * objective resources once, and every later turn can pull them on demand via
 * `get_goal` (`objective_resources` file paths), which the recovery prompt and
 * the periodic terminal audit already instruct the worker to call. Re-attaching
 * screenshots here would resend every image on every continuation turn.
 *
 * The one exception is a kickoff a pause retired before it ever ran: the first
 * resumed Goal Turn carries the same attachments that kickoff message would
 * have carried — its kickoff attachments plus the objective resources.
 */
export function buildThreadGoalContinuationMessage(goal, content, kind) {
    const firstGoalTurn = (goal.accounting?.goalTurns ?? goal.turnsUsed) === 0;
    return {
        content,
        attachments: kind === 'active' && firstGoalTurn
            ? [...(goal.kickoffAttachments ?? []), ...(goal.objectiveResources ?? [])].map((attachment) => ({ ...attachment }))
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
    const record = readThreadGoalKickoffOriginRecord(value);
    if (!record)
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
export function readThreadGoalContinuationOrigin(value) {
    const record = readOriginRecord(value, THREAD_GOAL_CONTINUATION_ORIGIN_TYPE);
    if (!record || !hasGoalIdentity(record))
        return undefined;
    if (record.kind !== 'active' && record.kind !== 'budget-limit')
        return undefined;
    return {
        type: THREAD_GOAL_CONTINUATION_ORIGIN_TYPE,
        goalId: record.goalId,
        goalUpdatedAt: record.goalUpdatedAt,
        objectiveDigest: record.objectiveDigest,
        kind: record.kind,
    };
}
/**
 * A queued continuation runs this Goal only if it was built at the Goal's
 * current epoch. One left from an older epoch is cancelled by queue
 * classification, so counting it as "already queued" would leave the Goal with
 * nothing to run it once that happens.
 */
export function isCurrentEpochThreadGoalContinuation(item, goal) {
    if (item.source !== 'thread-goal')
        return false;
    const origin = readThreadGoalContinuationOrigin(item.message.origin);
    return origin?.goalId === goal.goalId && origin.goalUpdatedAt === goal.updatedAt;
}
function hasGoalIdentity(record) {
    return (typeof record.goalId === 'string' &&
        record.goalId.length > 0 &&
        isUnixMs(record.goalUpdatedAt) &&
        typeof record.objectiveDigest === 'string');
}
function isUnixMs(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
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
export { isThreadGoalKickoffQueueItem } from '@mavis/goal';
//# sourceMappingURL=kickoff.js.map