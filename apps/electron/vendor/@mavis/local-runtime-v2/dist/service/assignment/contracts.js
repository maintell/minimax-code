/** States in which a task executes and holds one of the user's concurrent slots. */
export const EXECUTING_ASSIGNMENT_STATES = new Set([
    'queued',
    'running',
]);
/** States in which a task waits for the user's approval or answer and holds no slot. */
export const WAITING_ASSIGNMENT_STATES = new Set([
    'waiting_approval',
    'waiting_answer',
]);
/** States in which a task waits for the user. */
export const ATTENTION_ASSIGNMENT_STATES = new Set([
    'waiting_approval',
    'waiting_answer',
    'failed',
    'stopped',
    'review_failed',
]);
/**
 * Tasks one user (one data directory, across all of its task spaces) executes at once;
 * further tasks wait for a free slot. Spaces have no limit of their own.
 */
export const MAX_ACTIVE_ASSIGNMENTS = 20;
export function isAssignmentOrigin(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    return 'assignment' in value || 'assignmentReport' in value;
}
/**
 * The files a task delivered over all its rounds, each path once, for the
 * completion of a task that closes as done. Paths stay as delivered: absolute,
 * or relative to the task's workspace.
 */
export async function deliveredArtifacts(assets, sessionId) {
    const artifacts = [...new Set((await assets(sessionId)).map((asset) => asset.path))];
    return artifacts.length ? { artifacts } : {};
}
/**
 * The space link a task is opened with.
 *
 * Every optional field is written only when it applies, so a task that was not queued, was not
 * dispatched by a known Turn or was not woken by a known trigger records none of them.
 */
export function spaceLinkOf(input, spaceId, isProject, queuePosition) {
    return {
        spaceId,
        ...(queuePosition === undefined ? {} : { queuePosition }),
        ...(input.callerTurnId ? { dispatchTurnId: input.callerTurnId } : {}),
        spaceType: spaceId === 'default' ? 'bunny' : 'user',
        execLocation: isProject ? 'project' : 'space',
        ...(input.trigger ? { trigger: input.trigger } : {}),
    };
}
//# sourceMappingURL=contracts.js.map