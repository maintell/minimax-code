import { GOAL_VERIFIER_READONLY_PROFILE } from '@mavis/config';
import { createSubagentVerifierAdapter, VerificationDispatchError, } from '@mavis/goal';
import { createGoalVerifierChildExtension, createGoalVerifierOutputTokenCapResolver, GoalVerifierChildCoordinator, } from './goal-subagent-coordinator.js';
/**
 * Composes the Goal verifier backend: the generic adapter, the per-run counter
 * that the child Turn's hooks feed, and the reminder that carries the
 * verification contract.
 *
 * The child itself is an ordinary `verifier` delegation. Nothing here creates a
 * Session, submits a Turn, or touches a Goal repository.
 */
export function createGoalSubagentVerifierRuntime(options) {
    const coordinator = new GoalVerifierChildCoordinator();
    const execution = options.createExecution(coordinator);
    return {
        extension: createGoalVerifierChildExtension(coordinator),
        outputTokenCap: createGoalVerifierOutputTokenCapResolver(coordinator),
        verifier: {
            async dispatch(attempt, signal) {
                if (!execution) {
                    throw new VerificationDispatchError('route_unavailable', 'This host has no local delegation path for the Goal verifier child.', { tokens: 0, activeSeconds: 0, childTurns: 0, incomplete: false });
                }
                const policy = options.config().goal?.subagent;
                return createSubagentVerifierAdapter({
                    profile: policy?.profile ?? GOAL_VERIFIER_READONLY_PROFILE,
                    requiredProfile: GOAL_VERIFIER_READONLY_PROFILE,
                    ...(policy?.maxTurns !== undefined ? { maxTurns: policy.maxTurns } : {}),
                    ...(policy?.maxTokens !== undefined ? { maxTokens: policy.maxTokens } : {}),
                    ...(policy?.timeoutSeconds !== undefined
                        ? { timeoutSeconds: policy.timeoutSeconds }
                        : {}),
                    execution,
                    ...(options.nowMs ? { nowMs: options.nowMs } : {}),
                }).dispatch(attempt, signal);
            },
        },
    };
}
//# sourceMappingURL=goal-subagent-verifier.js.map