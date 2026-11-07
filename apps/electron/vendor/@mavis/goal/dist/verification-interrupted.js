/**
 * Resuming a Goal whose verification was interrupted (spec §14).
 *
 * A verification that stopped without a verdict — a verifier timeout, protocol
 * or runtime fault, its own budget, a missing capability, an abort — pauses
 * the Goal. Resuming it does not re-run that verification: the resume starts
 * an ordinary working Goal Turn, and this notice tells the worker why the last
 * verification ended and that completion has to be proposed again. The next
 * accepted proposal is verified exactly once, like any other.
 */
import { wrapInternalContext } from './internal-context-fragment.js';
/** True for a pause caused by a verification that ended without a verdict. */
export function isVerificationInterruptedReason(reason) {
    return (typeof reason === 'string' &&
        (reason.startsWith('paused(verifier_') || reason === 'paused(route_unavailable)'));
}
/** One-shot notice appended to the first working Goal Turn after such a resume. */
export function renderVerificationInterruptedNotice(reason) {
    return wrapInternalContext('goal', `The last verification of this goal was interrupted before it reached a verdict (reason: ${reason}). ` +
        'It will not be re-run on its own, and the earlier completion proposal no longer stands. ' +
        'Re-check the work against the objective now and fix anything that is missing or broken. ' +
        'When the objective is met, submit completion again with update_goal; the host verifies that new proposal.');
}
//# sourceMappingURL=verification-interrupted.js.map