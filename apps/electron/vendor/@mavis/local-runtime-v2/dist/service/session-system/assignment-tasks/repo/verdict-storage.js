import { readVerdict } from './verdict.js';
/** The verdict facts of `assignment` that `task.details_set` stores, in storage order. */
export function verdictFactsOf(assignment) {
    const reviewTask = assignment?.reviewTask;
    const verdict = assignment?.verdict;
    const verdictClaim = assignment?.verdictClaim;
    const verdictGateReleased = assignment?.verdictGateReleased;
    const reviewOf = assignment?.reviewOf;
    return {
        ...(reviewTask ? { reviewTask: { ...reviewTask } } : {}),
        ...(verdict ? { verdict } : {}),
        ...(verdictClaim ? { verdictClaim: { ...verdictClaim } } : {}),
        ...(verdictGateReleased ? { verdictGateReleased: { ...verdictGateReleased } } : {}),
        ...(reviewOf ? { reviewOf: { ...reviewOf } } : {}),
    };
}
/** Reads the verdict facts back out of a stored details payload, throwing when malformed. */
export function readVerdictFacts(value) {
    const reviewTask = Reflect.get(value, 'reviewTask');
    const verdict = Reflect.get(value, 'verdict');
    const verdictClaim = Reflect.get(value, 'verdictClaim');
    const verdictGateReleased = Reflect.get(value, 'verdictGateReleased');
    const reviewOf = Reflect.get(value, 'reviewOf');
    return {
        ...(reviewTask === undefined ? {} : { reviewTask: readReviewTask(reviewTask) }),
        ...(verdict === undefined
            ? {}
            : { verdict: readVerdict(verdict, 'task.details_set.verdict') }),
        ...(verdictClaim === undefined ? {} : { verdictClaim: readVerdictClaim(verdictClaim) }),
        ...(verdictGateReleased === undefined
            ? {}
            : { verdictGateReleased: readGateRelease(verdictGateReleased) }),
        ...(reviewOf === undefined ? {} : { reviewOf: readReviewOf(reviewOf) }),
    };
}
/** A review task link; the Session and the report it checks are both required. */
function readReviewTask(value) {
    const field = (key) => typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
    const sessionId = field('sessionId');
    const reportKey = field('reportKey');
    const at = field('at');
    if (typeof sessionId !== 'string' ||
        !sessionId ||
        typeof reportKey !== 'string' ||
        !reportKey ||
        typeof at !== 'number')
        throw new Error('task.details_set.reviewTask is malformed');
    return { sessionId, reportKey, at };
}
/** Who claimed which verdict revision; all three fields are required. */
function readVerdictClaim(value) {
    const field = (key) => typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
    const by = field('by');
    const at = field('at');
    const revision = field('revision');
    if (typeof by !== 'string' ||
        !by ||
        typeof at !== 'number' ||
        !isCount(revision) ||
        revision < 1)
        throw new Error('task.details_set.verdictClaim is malformed');
    return { by, at, revision };
}
/** A released gate; the review it belonged to and when it was released are both required. */
function readGateRelease(value) {
    const field = (key) => typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
    const reviewTaskId = field('reviewTaskId');
    const at = field('at');
    if (typeof reviewTaskId !== 'string' || !reviewTaskId || typeof at !== 'number')
        throw new Error('task.details_set.verdictGateReleased is malformed');
    return { reviewTaskId, at };
}
/** What a review task was asked to check; the Session is required, the report optional. */
function readReviewOf(value) {
    if (typeof value !== 'object' || value === null)
        throw new Error('task.details_set.reviewOf is malformed');
    const sessionId = Reflect.get(value, 'sessionId');
    const reportKey = Reflect.get(value, 'reportKey');
    if (typeof sessionId !== 'string' || !sessionId)
        throw new Error('task.details_set.reviewOf is malformed');
    if (reportKey !== undefined && typeof reportKey !== 'string')
        throw new Error('task.details_set.reviewOf is malformed');
    return reportKey === undefined ? { sessionId } : { sessionId, reportKey };
}
function isCount(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
//# sourceMappingURL=verdict-storage.js.map