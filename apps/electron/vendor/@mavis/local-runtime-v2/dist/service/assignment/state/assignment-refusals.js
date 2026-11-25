import { describeDispatchAttachmentRefusals, refusedDispatchAttachments, refusalsAreOnlyUnreadable, turnUserAttachmentPaths, } from '../../../infra/conversation/dispatch-attachments.js';
import { ASSIGNMENT_ERROR, assignmentTakenOver, NESTED_TASK_REFUSAL, } from '../../coordinator-text/index.js';
/**
 * The refusals the assignment service raises instead of an effect, and the error shape they
 * carry. Each one decides from its arguments alone, so the service that orchestrates a
 * dispatch keeps only the ordering of the checks, not their wording.
 */
/** An error carrying the `code` the tool layer maps to a refusal the assigner can read. */
export function coded(message, code) {
    return Object.assign(new Error(message), { code });
}
/**
 * Only Bunny's own conversations assign tasks, and never from inside a task of its own: a task
 * assigning further work would nest the tree past the two levels it has.
 *
 * The expected Agent name is a parameter rather than an import: this module is a leaf and must
 * not depend on the Bunny product service.
 */
export function assertBunnyAssigner(caller, isTaskSession, bunnyAgentName) {
    if (caller.agentName !== bunnyAgentName)
        throw Object.assign(new Error('Only Bunny can assign tasks'), {
            code: 'ASSIGNMENT_NOT_BUNNY',
        });
    if (isTaskSession)
        throw Object.assign(new Error(NESTED_TASK_REFUSAL), { code: 'ASSIGNMENT_NESTED_TASK' });
}
/** A queued task waits for its start; a cancelled or taken-over one is over. */
export function refuseSend(current) {
    if (current?.pendingStart)
        throw new Error(ASSIGNMENT_ERROR.sendQueued);
    const completion = current?.completion;
    // A cancelled task is over: carrying the work on is a new task.
    if (completion?.state === 'cancelled')
        throw coded(ASSIGNMENT_ERROR.sendCancelled, 'ASSIGNMENT_CANCELLED');
    if (completion?.state === 'taken_over')
        throw coded(assignmentTakenOver(completion.successorSessionId), 'ASSIGNMENT_TAKEN_OVER');
}
/** Rejects a conclusion the batch cannot record: a blank id or summary, or a repeated id. */
export function assertAcceptableConclusion(item, ids) {
    if (!item.sessionId.trim() || !item.summary.trim() || ids.has(item.sessionId))
        throw new Error('Task IDs must be unique and conclusions must not be empty');
}
/**
 * The assigner named files this task must start with. A refused one stops the dispatch before a
 * Session or a directory exists, so the assigner can fix the path and retry instead of losing a
 * half-created task to the create rollback.
 *
 * The code distinguishes the pre-existing "not a readable file" case, which callers may already
 * match on, from the newer refusals (secret-bearing path, over the volume caps).
 */
export async function requireReadableAttachments(attachments, turnId, turnMessages) {
    // A path the user attached in this very Turn is theirs even when the model names it: the send
    // tool has no auto-inherit, so naming is the only way to hand one over.
    //
    // Only worth reading when the assigner actually named paths — with none there is nothing to
    // compare against, and a whole extra Turn read whose result cannot change the outcome is worse
    // than useless: one Turn dispatching several tasks would pay it per task.
    const userAttached = turnMessages && attachments?.length
        ? await turnUserAttachmentPaths(turnId, turnMessages)
        : undefined;
    const refusals = await refusedDispatchAttachments(attachments, { userAttached });
    if (!refusals.length)
        return;
    throw coded(`attachments cannot be handed to the task: ${describeDispatchAttachmentRefusals(refusals)}`, refusalsAreOnlyUnreadable(refusals)
        ? 'ASSIGNMENT_ATTACHMENT_UNREADABLE'
        : 'ASSIGNMENT_ATTACHMENT_REFUSED');
}
//# sourceMappingURL=assignment-refusals.js.map