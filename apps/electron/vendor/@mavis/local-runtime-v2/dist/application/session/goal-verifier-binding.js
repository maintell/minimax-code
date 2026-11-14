import { createGoalEvaluatorVerifier } from '../agent/goal-evaluator-verifier.js';
import { createGoalVerificationTranscriptReader } from '../agent/goal-verification-transcript.js';
/** Goal verification: subagent attempts use the subagent verifier, others the evaluator. */
export function bindGoalVerifiers(input, subagent) {
    const evaluatorVerifier = createGoalEvaluatorVerifier({
        tuiProductPolicy: input.options.runtimeOwnerKind === 'tui',
        sessions: input.sessionSystem.sessions.execution,
        agents: input.product.agents,
        preparation: input.preparation,
        config: input.product.preparation.configBuilder.config,
        nowMs: input.nowMs,
    });
    input.goal.service.bindVerifier({
        dispatch: (attempt, signal) => attempt.backend === 'subagent'
            ? subagent.dispatch(attempt, signal)
            : evaluatorVerifier.dispatch(attempt, signal),
    }, createGoalVerificationTranscriptReader(input.sessionSystem.canonicalHistory));
}
//# sourceMappingURL=goal-verifier-binding.js.map