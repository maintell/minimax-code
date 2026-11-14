import { readVerdictFacts, verdictFactsOf, } from './verdict-storage.js';
const VIA = ['create', 'send'];
const COMPLETION_STATES = ['completed', 'cancelled', 'taken_over'];
const COMPLETION_ACTORS = ['assigner', 'user'];
const COMPLETION_REASONS = [
    'review_passed',
    'user_marked',
    'user_round',
    'cancelled',
    'taken_over',
    'stalled',
];
/** Spent redelivery of one report; written by review finishes. */
export const REVIEW_REDELIVERED = 'review.redelivered';
/** Replaces the retry budget wholesale: `{ reviewRetries: {...} | null }`. */
export const REVIEW_RETRIES_SET = 'review.retries_set';
/** Replaces the task facts the table has no column for, wholesale: `{ details: {...} }`. */
export const TASK_DETAILS_SET = 'task.details_set';
/** Events the projection folds next to the task row, in sequence order. */
export const PROJECTED_EVENT_TYPES = [
    REVIEW_REDELIVERED,
    REVIEW_RETRIES_SET,
    TASK_DETAILS_SET,
];
export function assignmentTaskId(sessionId) {
    return `tsk_${sessionId}`;
}
export function decodeAssignmentTask(row, facts = {}) {
    const where = `Assignment task ${row.taskId}`;
    return {
        assignerSessionId: row.assignerSessionId,
        assignerAgentName: row.assignerAgentName,
        reportBack: row.reportBack,
        assignedAt: row.assignedAtMs,
        via: requireMember(row.via, VIA, `${where}.via`),
        depth: row.depth,
        ...present('goal', row.goal),
        ...present('doneWhen', row.doneWhen),
        ...present('userWords', row.userWords),
        ...present('review', decodeReview(row, where)),
        ...present('completion', decodeCompletion(row, where, facts.details)),
        ...present('pendingStart', decodePendingStart(row, where)),
        ...present('requestId', row.requestId),
        ...present('requestAssignerSessionId', row.requestAssignerSessionId),
        ...present('lastReportedKey', row.lastReportedKey),
        ...present('reviewRetries', facts.reviewRetries),
        ...present('reviewError', facts.details?.reviewError),
        ...present('assignerWasRoot', row.assignerWasRoot),
        ...present('reviewTask', facts.details?.reviewTask),
        ...present('verdict', facts.details?.verdict),
        ...present('verdictClaim', facts.details?.verdictClaim),
        ...present('reviewOf', facts.details?.reviewOf),
    };
}
/** An optional projection key, omitted rather than set to null or undefined. */
function present(key, value) {
    return value === null || value === undefined
        ? {}
        : { [key]: value };
}
function decodeReview(row, where) {
    if (row.reviewSessionId === null)
        return undefined;
    return {
        sessionId: row.reviewSessionId,
        turnId: required(row.reviewTurnId, `${where}.review_turn_id`),
        reportKey: required(row.reviewReportKey, `${where}.review_report_key`),
        summary: row.reviewSummary ?? '',
    };
}
function decodeCompletion(row, where, details) {
    if (row.completionState === null)
        return undefined;
    return {
        state: requireMember(row.completionState, COMPLETION_STATES, `${where}.completion_state`),
        by: requireMember(required(row.completionBy, `${where}.completion_by`), COMPLETION_ACTORS, `${where}.completion_by`),
        at: required(row.completionAtMs, `${where}.completion_at_ms`),
        ...(details?.completionReason ? { reason: details.completionReason } : {}),
        ...(row.completionSummary === null ? {} : { summary: row.completionSummary }),
        ...(details?.completionArtifacts ? { artifacts: [...details.completionArtifacts] } : {}),
        ...(details?.successorSessionId ? { successorSessionId: details.successorSessionId } : {}),
    };
}
function decodePendingStart(row, where) {
    if (row.pendingStartContent === null)
        return undefined;
    return {
        content: row.pendingStartContent,
        queuedAt: required(row.pendingStartQueuedAtMs, `${where}.pending_start_queued_at_ms`),
    };
}
/** Columns owned by a projection; identity, revision and timestamps are added by the writer. */
export function encodeAssignmentTask(assignment) {
    validateAssignment(assignment);
    return {
        assignerSessionId: assignment.assignerSessionId,
        assignerAgentName: assignment.assignerAgentName,
        assignerWasRoot: assignment.assignerWasRoot ?? null,
        via: assignment.via,
        depth: assignment.depth,
        reportBack: assignment.reportBack,
        assignedAtMs: assignment.assignedAt,
        goal: assignment.goal ?? null,
        doneWhen: assignment.doneWhen ? [...assignment.doneWhen] : null,
        userWords: assignment.userWords ?? null,
        requestId: assignment.requestId ?? null,
        requestAssignerSessionId: assignment.requestAssignerSessionId ?? null,
        lastReportedKey: assignment.lastReportedKey ?? null,
        ...encodeGroups(assignment),
    };
}
/** Grouped facts are stored whole or not at all, matching the table checks. */
function encodeGroups({ pendingStart, completion, review }) {
    return {
        pendingStartContent: pendingStart?.content ?? null,
        pendingStartQueuedAtMs: pendingStart?.queuedAt ?? null,
        ...encodeCompletion(completion),
        reviewSessionId: review?.sessionId ?? null,
        reviewTurnId: review?.turnId ?? null,
        reviewReportKey: review?.reportKey ?? null,
        reviewSummary: review?.summary ?? null,
    };
}
function encodeCompletion(completion) {
    return {
        completionState: completion?.state ?? null,
        completionBy: completion?.by ?? null,
        completionAtMs: completion?.at ?? null,
        completionSummary: completion?.summary ?? null,
    };
}
/**
 * Folds the projected events in sequence order. A redelivery sets the budget
 * spent on its report; a wholesale set (restore, reassignment, a finished
 * review) replaces or clears it. The latest details event holds the details.
 */
export function projectTaskFacts(events) {
    let reviewRetries;
    let details;
    for (const event of events) {
        if (event.type === REVIEW_REDELIVERED) {
            const reportKey = event.payload.reportKey;
            const attempt = event.payload.attempt;
            reviewRetries =
                typeof reportKey === 'string' && isCount(attempt)
                    ? { reportKey, count: attempt }
                    : undefined;
        }
        else if (event.type === REVIEW_RETRIES_SET) {
            reviewRetries = readRetries(event.payload.reviewRetries);
        }
        else if (event.type === TASK_DETAILS_SET) {
            details = readDetails(event.payload.details);
        }
    }
    return {
        ...(reviewRetries ? { reviewRetries } : {}),
        ...(details ? { details } : {}),
    };
}
/** The facts of `assignment` that `task.details_set` stores. */
export function taskDetails(assignment) {
    const reason = assignment?.completion?.reason;
    const artifacts = assignment?.completion?.artifacts;
    const successor = assignment?.completion?.successorSessionId;
    const reviewError = assignment?.reviewError;
    return {
        ...(reason ? { completionReason: reason } : {}),
        ...(artifacts?.length ? { completionArtifacts: [...artifacts] } : {}),
        ...(successor ? { successorSessionId: successor } : {}),
        ...(reviewError
            ? {
                reviewError: {
                    reportKey: reviewError.reportKey,
                    reason: reviewError.reason,
                    at: reviewError.at,
                },
            }
            : {}),
        ...verdictFactsOf(assignment),
    };
}
/** Details are always built by {@link taskDetails}, so equal facts serialize the same. */
export function sameTaskDetails(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
function readDetails(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const reason = Reflect.get(value, 'completionReason');
    const artifacts = readArtifacts(Reflect.get(value, 'completionArtifacts'));
    const successor = Reflect.get(value, 'successorSessionId');
    const reviewError = Reflect.get(value, 'reviewError');
    return {
        ...(reason === undefined
            ? {}
            : {
                completionReason: requireMember(String(reason), COMPLETION_REASONS, 'task.details_set.completionReason'),
            }),
        ...(artifacts?.length ? { completionArtifacts: artifacts } : {}),
        ...(typeof successor === 'string' && successor ? { successorSessionId: successor } : {}),
        ...(reviewError === undefined ? {} : { reviewError: readReviewError(reviewError) }),
        ...readVerdictFacts(value),
    };
}
function readArtifacts(value) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item))
        throw new Error('task.details_set.completionArtifacts is malformed');
    return value;
}
function readReviewError(value) {
    const field = (key) => typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
    const reportKey = field('reportKey');
    const reason = field('reason');
    const at = field('at');
    if (typeof reportKey !== 'string' || typeof reason !== 'string' || typeof at !== 'number')
        throw new Error('task.details_set.reviewError is malformed');
    return { reportKey, reason, at };
}
export function sameReviewRetries(left, right) {
    return left?.reportKey === right?.reportKey && left?.count === right?.count;
}
function readRetries(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const reportKey = Reflect.get(value, 'reportKey');
    const count = Reflect.get(value, 'count');
    return typeof reportKey === 'string' && isCount(count) ? { reportKey, count } : undefined;
}
function isCount(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function validateAssignment(assignment) {
    requireMember(assignment.via, VIA, 'assignment.via');
    // Only Bunny assigns, and its tasks never assign further: every task is one level deep.
    if (assignment.depth !== 1)
        throw new Error('assignment.depth must be 1');
    if (!assignment.assignerSessionId.trim() || !assignment.assignerAgentName.trim())
        throw new Error('assignment assigner must not be empty');
    if (!Number.isSafeInteger(assignment.assignedAt))
        throw new Error('assignment.assignedAt must be a safe integer');
    if (assignment.doneWhen?.some((item) => typeof item !== 'string' || !item.trim()))
        throw new Error('assignment.doneWhen must contain non-empty strings');
    if (assignment.completion) {
        requireMember(assignment.completion.state, COMPLETION_STATES, 'completion.state');
        requireMember(assignment.completion.by, COMPLETION_ACTORS, 'completion.by');
        if (assignment.completion.reason !== undefined)
            requireMember(assignment.completion.reason, COMPLETION_REASONS, 'completion.reason');
        if (assignment.completion.artifacts?.some((item) => typeof item !== 'string' || !item.trim()))
            throw new Error('completion.artifacts must contain non-empty paths');
    }
}
function requireMember(value, allowed, field) {
    if (!allowed.includes(value))
        throw new Error(`${field} has unsupported value ${value}`);
    return value;
}
function required(value, field) {
    if (value === null)
        throw new Error(`${field} is missing`);
    return value;
}
//# sourceMappingURL=codec.js.map