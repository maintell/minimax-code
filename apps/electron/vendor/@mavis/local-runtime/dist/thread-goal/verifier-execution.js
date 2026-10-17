import { randomUUID } from 'node:crypto';
import { VerificationDispatchError, } from '@mavis/goal';
import { stripModelVerdictCandidates } from '@mavis/agent-tools/desktop';
import { runForegroundLocalTask } from '../api/local-task-runner.js';
/**
 * Runs the Goal verifier child as an ordinary foreground delegation.
 *
 * Everything the bespoke runtime used to build by hand — hidden child Session,
 * background task row, abort plumbing, verdict parsing — already exists on this
 * path and is exercised by every other `task` call. What stays Goal-specific is
 * the run id stamped into the child Turn's origin, which is what lets the host
 * recognize the Turn and attach the verifier reminder, the narrow tool guard,
 * and this run's caps.
 */
export function createLocalGoalVerifierExecution(host, registry, observer) {
    return {
        async run(input) {
            const parent = await host.getSessionById(input.attempt.sessionId);
            if (!parent) {
                throw dispatchFailure('spawn_failed', 'Goal verifier parent Session is unavailable.');
            }
            const workerRouteProvider = modelRouteProvider(input.attempt.workerModelKey);
            if (!workerRouteProvider) {
                throw dispatchFailure('route_unavailable', 'Goal verifier worker data route is unavailable.');
            }
            const runId = randomUUID();
            const startedAt = Date.now();
            registry.register({
                runId,
                ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
                ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
                workerRouteProvider,
                hostContext: input.attempt.hostContext,
            });
            // Released on every exit so a crashed run cannot leave its caps behind
            // for the next one; the outcome below is read from that same release.
            let outcome;
            const releaseRun = () => {
                outcome = registry.release(runId);
            };
            const elapsed = () => Math.max(0, Math.ceil((Date.now() - startedAt) / 1_000));
            /**
             * A latched issue always wins: it names what actually stopped the run,
             * while the delegation result only reports that the Turn ended.
             */
            const failure = (code, message, traceRef) => outcome?.issue
                ? dispatchFailure(outcome.issue.code, outcome.issue.message, childUsage(outcome, elapsed()), traceRef)
                : dispatchFailure(code, message, childUsage(outcome, elapsed()), traceRef);
            let result;
            try {
                result = await runForegroundLocalTask({
                    host,
                    parentSession: parent,
                    toolCtx: {
                        sessionId: parent.sessionId,
                        turnId: input.attempt.turnId,
                        toolCallId: `goal-verifier:${runId}`,
                    },
                    taskInput: {
                        description: 'Goal verification',
                        prompt: input.prompt,
                        agent_name: 'verifier',
                        // Pins the child to the settled worker's data route rather than
                        // letting the target Agent or inherited Session selection pick a different provider.
                        model: input.attempt.workerModelKey,
                    },
                    origin: {
                        goalVerifier: {
                            runId,
                            profile: input.profile,
                            parentGoalId: input.attempt.goalId,
                            parentTurnId: input.attempt.turnId,
                        },
                    },
                    onChildStarted: (child) => {
                        const traceRef = { sessionId: child.subSessionId, turnId: child.subTurnId };
                        try {
                            input.onTrace?.(traceRef);
                        }
                        catch {
                            // The verifier's own trace propagation is best-effort.
                        }
                        try {
                            observer?.onChildStarted({ attempt: input.attempt, traceRef });
                        }
                        catch {
                            // Runtime observation must never change verifier execution.
                        }
                    },
                    signal: input.signal,
                }).finally(releaseRun);
            }
            catch (error) {
                throw input.signal.aborted
                    ? failure('aborted', 'Goal verifier child was aborted.')
                    : failure('child_crash', describeError(error));
            }
            if (outcome?.issue) {
                const traceRef = traceRefOf(result);
                throw dispatchFailure(outcome.issue.code, outcome.issue.message, childUsage(outcome, elapsed()), traceRef);
            }
            // A result that lands after cancellation is discarded: the dispatching
            // adapter stopped waiting on this run, so it must never become a verdict.
            if (input.signal.aborted) {
                throw failure('aborted', 'Goal verifier child was aborted.', traceRefOf(result));
            }
            if (result.status !== 'succeeded') {
                throw failure(result.status === 'aborted' ? 'aborted' : 'child_crash', result.errorMessage ?? 'Goal verifier child failed.', traceRefOf(result));
            }
            const parsedVerdict = result.verification?.modelVerdict;
            const traceRef = traceRefOf(result);
            return {
                finalText: result.finalText ?? '',
                verdictProse: stripModelVerdictCandidates(result.finalText ?? ''),
                ...(parsedVerdict ? { modelVerdict: parsedVerdict } : {}),
                tokens: outcome ? outcome.tokens : null,
                childTurns: outcome?.childTurns ?? 0,
                incomplete: outcome?.usageIncomplete ?? true,
                ...(traceRef ? { traceRef } : {}),
            };
        },
    };
}
function childUsage(outcome, activeSeconds) {
    return outcome
        ? {
            tokens: outcome.tokens,
            activeSeconds,
            childTurns: outcome.childTurns,
            incomplete: outcome.usageIncomplete,
        }
        : { tokens: null, activeSeconds, childTurns: 0, incomplete: true };
}
function dispatchFailure(code, message, usage = { tokens: null, activeSeconds: 0, childTurns: 0, incomplete: true }, traceRef) {
    return new VerificationDispatchError(code, message, usage, { traceRef });
}
function traceRefOf(result) {
    return result.subSessionId
        ? {
            sessionId: result.subSessionId,
            ...(result.subTurnId ? { turnId: result.subTurnId } : {}),
        }
        : undefined;
}
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Provider half of a source-qualified model key (`custom_provider:acme/model`). */
function modelRouteProvider(modelKey) {
    const normalized = modelKey.trim();
    const separator = normalized.indexOf('/');
    return separator > 0 && separator < normalized.length - 1
        ? normalized.slice(0, separator)
        : undefined;
}
//# sourceMappingURL=verifier-execution.js.map