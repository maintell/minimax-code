/**
 * Task history written next to the state change it describes. Payloads carry
 * only identifiers, enums, counts and durations: never a title, goal, report
 * text or anything the user typed.
 */
const TASK_OPENED = 'task.opened';
const TASK_QUEUED = 'task.queued';
const TASK_ADMITTED = 'task.admitted';
const TASK_REASSIGNED = 'task.reassigned';
/** A send whose message was never admitted put the previous round back. */
const TASK_REASSIGN_REVERTED = 'task.reassign_reverted';
const TASK_REPORTED = 'task.reported';
/** Appended whenever a review ends, with the coordinator Turn that held it. */
export const REVIEW_FINISHED = 'review.finished';
/**
 * A dispatched review stopped holding the task's conclusion; history only. Carries `released`
 * and `cause` so the event cannot be read as a gate release when it was only a replacement.
 */
const TASK_VERDICT_REVIEW_ABANDONED = 'task.verdict_review_abandoned';
const TASK_CLOSED = 'task.closed';
const TASK_REOPENED = 'task.reopened';
/** Appended by observers, not derived from a projection change. */
export const TASK_ROUND_ENDED = 'task.round_ended';
/** Events for one transition, in the order they happened. */
export function diffTaskEvents(input) {
    return [
        opened(input),
        reassigned(input),
        reverted(input),
        queued(input),
        admitted(input),
        reported(input),
        reviewFinished(input),
        verdictReviewAbandoned(input),
        closed(input),
        reopened(input),
    ].filter((event) => event !== undefined);
}
function opened({ current, next, note }) {
    if (current)
        return undefined;
    return {
        type: TASK_OPENED,
        payload: {
            via: next.via,
            depth: next.depth,
            assigner: next.assignerAgentName,
            ...optional('spaceId', note?.spaceId),
            ...optional('dispatchTurnId', note?.dispatchTurnId),
            ...optional('execLocation', note?.execLocation),
            ...optional('trigger', note?.trigger),
        },
    };
}
function reassigned({ kind, current, next, note }) {
    if (kind !== 'reassign' || !current || sameRound(current, next))
        return undefined;
    return {
        type: TASK_REASSIGNED,
        payload: {
            ...optional('reason', note?.reason),
            ...optional('dispatchTurnId', note?.dispatchTurnId),
        },
    };
}
function reverted({ kind, current, next }) {
    if (kind !== 'restore' || !current || sameRound(current, next))
        return undefined;
    return { type: TASK_REASSIGN_REVERTED, payload: {} };
}
function queued({ kind, next, note }) {
    if (kind !== 'open' || !next.pendingStart)
        return undefined;
    return { type: TASK_QUEUED, payload: optional('position', note?.queuePosition) };
}
function admitted(input) {
    const { kind, current, next, note, nowMs } = input;
    const pending = current?.pendingStart;
    if (kind !== 'clearPendingStart' || !pending || next.completion || note?.startFailed)
        return undefined;
    return { type: TASK_ADMITTED, payload: { waitedMs: Math.max(0, nowMs - pending.queuedAt) } };
}
function reported({ kind, next, note }) {
    if (kind !== 'recordReport')
        return undefined;
    return {
        type: TASK_REPORTED,
        payload: {
            ...optional('turnId', note?.round?.turnId),
            ...optional('state', note?.round?.state),
            reviewing: next.review?.reportKey === next.lastReportedKey,
        },
    };
}
function reviewFinished(input) {
    const { kind, current, next } = input;
    if (!current?.review || next.review || !REVIEW_ENDING.has(kind))
        return undefined;
    // Which delivery of this report the finished review was: 1 unless it was redelivered.
    const spent = current.reviewRetries;
    const attempt = spent?.reportKey === current.review.reportKey ? spent.count + 1 : 1;
    return {
        type: REVIEW_FINISHED,
        payload: { result: reviewResult(input), attempt, reviewTurnId: current.review.turnId },
    };
}
const REVIEW_ENDING = new Set(['finishReview', 'reassign', 'reopen']);
/**
 * The review task linked to a task stopped holding its conclusion. Derived from the link
 * going away, so it covers both an abandoned review and one a newer dispatch replaced.
 *
 * Those two are not the same fact, and only the first writes `verdictGateReleased`
 * ({@link assignmentTransitions.abandonVerdictReview}); a `reassign` or `restore` replaces the
 * whole projection and drops the link without releasing anything. So the payload says which
 * happened: `released` mirrors whether this review's gate really was released in storage, and
 * `cause` names the path. A reader that took the event name alone as "the gate is open and no
 * conclusion is held" would otherwise read the opposite of `verdictGateReleased`.
 */
function verdictReviewAbandoned({ current, next }) {
    const reviewTask = current?.reviewTask;
    if (!reviewTask || next.reviewTask)
        return undefined;
    const released = next.verdictGateReleased?.reviewTaskId === reviewTask.sessionId;
    return {
        type: TASK_VERDICT_REVIEW_ABANDONED,
        payload: {
            reviewTaskId: reviewTask.sessionId,
            reportKey: reviewTask.reportKey,
            released,
            cause: released ? 'abandoned' : 'replaced',
        },
    };
}
function reviewResult({ kind, current, next, note }) {
    if (note?.reviewResult)
        return note.reviewResult;
    if (kind === 'reassign')
        return 'sent_back';
    if (kind === 'reopen')
        return 'superseded';
    if (next.completion && !current?.completion)
        return 'passed';
    return next.reviewRetries ? 'failed' : 'stopped';
}
function closed(input) {
    const { kind, current, next, nowMs, closeStats } = input;
    const completion = next.completion;
    if (!completion || current?.completion || (kind !== 'close' && kind !== 'finishReview'))
        return undefined;
    const stats = closeStats();
    return {
        type: TASK_CLOSED,
        payload: {
            state: completion.state,
            by: completion.by,
            ...optional('reason', completion.reason),
            rounds: stats.rounds,
            userTurns: stats.userTurns,
            userMessages: stats.userMessages,
            userTookOver: stats.userMessages > 0,
            durationMs: Math.max(0, nowMs - stats.openedAtMs),
            ...optional('totalTokens', stats.totalTokens),
        },
    };
}
function reopened({ kind, current, note }) {
    if (kind !== 'reopen' || !current?.completion)
        return undefined;
    return { type: TASK_REOPENED, payload: optional('turnId', note?.turnId) };
}
function sameRound(left, right) {
    return left.assignedAt === right.assignedAt && left.assignerSessionId === right.assignerSessionId;
}
function optional(key, value) {
    return value === undefined ? {} : { [key]: value };
}
//# sourceMappingURL=events.js.map