import { LocalEventSink } from '../events/sink.js';
import { beginLocalEvalTurn, failLocalEvalTurn, finishLocalEvalTurn, observeApprovedLocalEvalAssistantMessages, withLocalEvalReporting, } from '../eval/host-hooks.js';
import { deriveLocalRuntimeTurnOutcome } from './turn-outcome.js';
/**
 * Owns the fail-open eval lifecycle around one local runtime turn. The observed
 * sink is the same sink passed to output safety, so only approved assistant
 * output can enter the trajectory.
 */
export async function runLocalRuntimeEvalTurn(options) {
    const { input } = options;
    const eventWriter = input.eventWriter ?? new LocalEventSink();
    const reporter = beginLocalEvalTurn(options.reporterFactory, {
        sessionId: input.sessionId,
        workspaceDir: input.workspaceDir,
        ...(input.evalSessionFields ? { sessionFields: input.evalSessionFields } : {}),
        turnId: input.turnId,
        userMessage: input.userMessage.text,
        model: input.llm.model,
        apiKey: input.llm.apiKey,
    });
    const stopObservingApprovedMessages = reporter
        ? observeApprovedLocalEvalAssistantMessages(eventWriter, reporter, input.llm.model)
        : undefined;
    try {
        const output = await options.execute({
            ...input,
            eventWriter,
            ...(reporter
                ? { hooks: withLocalEvalReporting(input.hooks, reporter, input.llm.model) }
                : {}),
        });
        const outcome = deriveLocalRuntimeTurnOutcome(output.events);
        finishLocalEvalTurn(reporter, output.retracted || output.networkStopped ? { ...outcome, status: 'aborted' } : outcome);
        return output;
    }
    catch (error) {
        failLocalEvalTurn(reporter, error, Boolean(input.signal?.aborted));
        throw error;
    }
    finally {
        stopObservingApprovedMessages?.();
    }
}
//# sourceMappingURL=host-eval.js.map