import { verdictIdempotencyKey, } from '../../session-system/index.js';
/**
 * The verdict layer of a task's status:
 *
 * - a review is running and has not reported yet -> `verdictReviewing` (正在检查结果)
 * - a verdict landed and nobody claimed it -> `awaitingConclusion` (等 Bunny 核对)
 *
 * A task no review was dispatched for gets none of these fields, so its status is byte
 * for byte what it was before verdicts existed.
 */
export function verdictStatus(assignment) {
    const verdict = assignment?.verdict;
    // A closed task is over: a review link or an unclaimed verdict it still carries says
    // nothing about it any more, and reporting either would contradict its closure.
    if (assignment?.completion)
        return verdict ? { verdict } : {};
    if (!verdictGated(assignment))
        return verdict ? { verdict } : {};
    if (!verdict)
        return { verdictReviewing: true };
    const claimed = assignment?.verdictClaim?.revision === verdict.revision;
    return claimed ? { verdict } : { awaitingConclusion: true, verdict };
}
/**
 * Whether this task's conclusion is gated on a review verdict. Only a task a review was
 * dispatched for is gated; every other task keeps today's behaviour exactly.
 */
function verdictGated(assignment) {
    return assignment?.reviewTask !== undefined;
}
/** Whether this task's conclusion is gated on a review verdict, for callers outside this module. */
export function isVerdictGated(assignment) {
    return verdictGated(assignment) && assignment?.completion === undefined;
}
/**
 * The tool a coordinator turn calls to take a stored verdict into itself.
 *
 * A local literal rather than an import: the tool is registered in `@mavis/agent-tools`,
 * which local-runtime-v2 depends on and which must never depend on local-runtime-v2.
 * `local-assignment-tools.ts` exports the same name for its own registration, and each side
 * pins the literal in a test, so renaming one without the other fails a suite.
 */
export const VERDICT_CLAIM_TOOL = 'assignment_claim_verdict';
/**
 * Why a gated task may not be concluded yet, or undefined when it may.
 *
 * The gate is deliberately two-step: a verdict has to be stored (the review reported)
 * and then claimed by a coordinator turn (Bunny read it). That keeps "closing a task
 * takes Bunny's confirmation" true for the new path as well — a verdict alone never
 * closes anything. The claim is an explicit call rather than a side effect of the wake or
 * of concluding: the point of the mechanism is that reading the verdict is provable, and
 * an implicit claim would make "Bunny read it" unverifiable.
 *
 * Pure: it reads the task, never the switch. A gate that is switched off stops holding
 * anything, and the one caller that decides that is
 * {@link AssignmentVerdictWiring.conclusionBlock}.
 */
export function verdictGateBlock(assignment) {
    if (!verdictGated(assignment))
        return undefined;
    if (!assignment.verdict)
        return 'This task is being reviewed: wait for the review verdict before concluding it.';
    const claim = assignment.verdictClaim;
    if (!claim || claim.revision !== assignment.verdict.revision)
        return (`The review verdict has not been read yet: call ${VERDICT_CLAIM_TOOL} with this task's ` +
            'session_id to read it, then conclude the task.');
    return undefined;
}
/**
 * Links a review task to the task it checks, so that task's conclusion becomes gated on
 * the review's verdict. Any verdict an earlier review left is dropped.
 */
export function startVerdictReview(store, input) {
    return store.tasks.startVerdictReview(input.sessionId, {
        sessionId: input.reviewTaskId,
        reportKey: input.reportKey,
        at: store.nowMs(),
    });
}
/**
 * Stores a review verdict and wakes the assigner once per verdict.
 *
 * Idempotency is enforced by the store, not by the caller: the same verdict (same review
 * task and revision) delivered twice applies once, and the wake is claimed through a
 * dedupe key so a redelivery never produces a second turn. Nothing here has to be told
 * not to resend.
 */
export async function recordVerdict(store, input) {
    const applied = await store.tasks.recordVerdict(input.sessionId, input.verdict);
    if (!applied)
        return { applied: false, claimed: false };
    // One wake per verdict: the dedupe key is the verdict's own idempotency key.
    const claimed = await store.tasks.appendEvent(input.sessionId, {
        type: 'task.verdict_recorded',
        payload: {
            reviewTaskId: input.verdict.reviewTaskId,
            revision: input.verdict.revision,
            outcome: input.verdict.outcome,
            source: input.verdict.source,
            parseFailed: input.verdict.parseFailed === true,
        },
        dedupeKey: verdictIdempotencyKey({
            reviewTaskId: input.verdict.reviewTaskId,
            revision: input.verdict.revision,
        }),
    });
    store.mark(input.sessionId);
    // Only a first-time claim wakes the assigner; a redelivery never does.
    if (claimed)
        store.onRecorded?.(input.sessionId, input.verdict);
    return { applied: true, claimed };
}
/** A coordinator turn takes the stored verdict; only a stored verdict can be claimed. */
export async function claimStoredVerdict(store, input) {
    const claimed = await store.tasks.claimVerdict(input.sessionId, {
        by: input.by,
        at: store.nowMs(),
    });
    if (claimed)
        store.mark(input.sessionId);
    return claimed;
}
//# sourceMappingURL=verdict-gate.js.map