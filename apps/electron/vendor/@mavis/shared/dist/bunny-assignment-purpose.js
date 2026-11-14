/**
 * Identity of a task Session Bunny dispatched.
 *
 * Bunny's assignments are created with `sessionKind: 'conversation'` and no
 * parent link, so a surface that recognizes delegated work by `sessionKind:
 * 'task'` or by a worker purpose prefix cannot tell them apart from a Session
 * the user opened. The assigner is recorded in the task graph, not on the
 * Session record, so a Session-only reader has no way back to the coordinator
 * that owns the task.
 *
 * The purpose carries that link: `bunny-assignment:<assignerSessionId>`. It is
 * the same mechanism the delegation (`local-task:`), Team plan (`team-plan:`)
 * and cron (`cron:`) paths already use, so a reader that already loads Session
 * purposes needs no extra port to place an assignment under its coordinator.
 */
/** Stable prefix for Sessions Bunny created for a dispatched task. */
export const BUNNY_ASSIGNMENT_PURPOSE_PREFIX = 'bunny-assignment:';
/** Purpose marking `assignerSessionId` as the coordinator that dispatched the task. */
export function createBunnyAssignmentPurpose(assignerSessionId) {
    return `${BUNNY_ASSIGNMENT_PURPOSE_PREFIX}${assignerSessionId}`;
}
/**
 * The coordinator Session that dispatched the task this Session runs, or
 * `undefined` when the purpose was not written by an assignment dispatch.
 */
export function parseBunnyAssignmentPurpose(purpose) {
    if (!purpose?.startsWith(BUNNY_ASSIGNMENT_PURPOSE_PREFIX))
        return undefined;
    return purpose.slice(BUNNY_ASSIGNMENT_PURPOSE_PREFIX.length).trim() || undefined;
}
//# sourceMappingURL=bunny-assignment-purpose.js.map