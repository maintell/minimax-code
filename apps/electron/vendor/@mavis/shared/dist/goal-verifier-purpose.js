/**
 * Identity of a Goal verification child Session.
 *
 * The Goal verifier runs through the ordinary `task` delegation with the
 * built-in `verifier` agent, so agent name, parent link and session kind look
 * exactly like a user asking the main agent to "have a subagent review this".
 * What differs is the tool call id the Goal run passes in: the delegation
 * persists it into the child's purpose as `local-task:<turnId>:<toolCallId>`,
 * and only the Goal run uses the `goal-verifier:` prefix there.
 */
/** Tool call id prefix of the delegation a Goal verifier run starts. */
export const GOAL_VERIFIER_TOOL_CALL_ID_PREFIX = 'goal-verifier:';
/** Tool call id a Goal verifier run hands to the delegation. */
export function createGoalVerifierToolCallId(runId) {
    return `${GOAL_VERIFIER_TOOL_CALL_ID_PREFIX}${runId}`;
}
/** Whether a Session purpose was written by a Goal verifier run's delegation. */
export function isGoalVerifierTaskPurpose(purpose) {
    return (typeof purpose === 'string' &&
        purpose.startsWith('local-task:') &&
        purpose.includes(`:${GOAL_VERIFIER_TOOL_CALL_ID_PREFIX}`));
}
//# sourceMappingURL=goal-verifier-purpose.js.map