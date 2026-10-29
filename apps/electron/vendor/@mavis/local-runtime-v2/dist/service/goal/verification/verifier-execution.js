import { randomUUID } from 'node:crypto';
import { VerificationDispatchError, } from '@mavis/goal';
import { stripModelVerdictCandidates } from '@mavis/agent-tools/desktop';
import { createGoalVerifierToolCallId } from '@mavis/shared/goal-verifier-purpose';
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
export function createLocalGoalVerifierExecution(runner, registry, observer) {
    return {
        async run(input) {
            if (!(await runner.hasSession(input.attempt.sessionId))) {
                throw dispatchFailure('spawn_failed', 'Goal verifier parent Session is unavailable.');
            }
            const workerRouteProvider = modelRouteProvider(input.attempt.workerModelKey);
            if (!workerRouteProvider) {
                throw dispatchFailure('route_unavailable', 'Goal verifier worker data route is unavailable.');
            }
            const run = new GoalVerifierRun(registry, input, workerRouteProvider);
            const result = await run.execute(runner, observer);
            run.assertUsable(result);
            return run.toRunResult(result);
        },
    };
}
/** One verifier child run: its caps registration, execution and result shaping. */
class GoalVerifierRun {
    registry;
    input;
    runId = randomUUID();
    startedAt = Date.now();
    outcome;
    constructor(registry, input, workerRouteProvider) {
        this.registry = registry;
        this.input = input;
        registry.register({
            runId: this.runId,
            ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
            ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
            workerRouteProvider,
            hostContext: input.attempt.hostContext,
            objective: input.attempt.objective,
        });
    }
    async execute(runner, observer) {
        const { input, runId } = this;
        try {
            return await runner.runForeground({
                parentSessionId: input.attempt.sessionId,
                toolCtx: {
                    sessionId: input.attempt.sessionId,
                    turnId: input.attempt.turnId,
                    toolCallId: createGoalVerifierToolCallId(runId),
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
                // The child never runs with more than its parent Session allows.
                prepareChild: ({ subSessionId }) => runner.inheritSessionRestrictions({
                    sourceSessionId: input.attempt.sessionId,
                    targetSessionId: subSessionId,
                }),
                onChildStarted: (child) => notifyChildStarted(input, observer, child),
                signal: input.signal,
            });
        }
        catch (error) {
            this.release();
            throw input.signal.aborted
                ? this.failure('aborted', 'Goal verifier child was aborted.')
                : this.failure('child_crash', describeError(error));
        }
        finally {
            // Released on every exit so a crashed run cannot leave its caps behind
            // for the next one; the outcome below is read from that same release.
            this.release();
        }
    }
    assertUsable(result) {
        if (this.outcome?.issue) {
            throw dispatchFailure(this.outcome.issue.code, this.outcome.issue.message, childUsage(this.outcome, this.elapsed()), traceRefOf(result));
        }
        // A result that lands after cancellation is discarded: the dispatching
        // adapter stopped waiting on this run, so it must never become a verdict.
        if (this.input.signal.aborted) {
            throw this.failure('aborted', 'Goal verifier child was aborted.', traceRefOf(result));
        }
        if (result.status !== 'succeeded') {
            throw this.failure(result.status === 'aborted' ? 'aborted' : 'child_crash', result.errorMessage ?? 'Goal verifier child failed.', traceRefOf(result));
        }
    }
    toRunResult(result) {
        const parsedVerdict = result.verification?.modelVerdict;
        const traceRef = traceRefOf(result);
        const outcome = this.outcome;
        return {
            finalText: result.finalText ?? '',
            verdictProse: stripModelVerdictCandidates(result.finalText ?? ''),
            ...(parsedVerdict ? { modelVerdict: parsedVerdict } : {}),
            tokens: outcome ? outcome.tokens : null,
            childTurns: outcome?.childTurns ?? 0,
            incomplete: outcome?.usageIncomplete ?? true,
            ...(traceRef ? { traceRef } : {}),
        };
    }
    release() {
        if (this.released)
            return;
        this.released = true;
        this.outcome = this.registry.release(this.runId);
    }
    released = false;
    elapsed() {
        return Math.max(0, Math.ceil((Date.now() - this.startedAt) / 1_000));
    }
    /**
     * A latched issue always wins: it names what actually stopped the run,
     * while the delegation result only reports that the Turn ended.
     */
    failure(code, message, traceRef) {
        const usage = childUsage(this.outcome, this.elapsed());
        return this.outcome?.issue
            ? dispatchFailure(this.outcome.issue.code, this.outcome.issue.message, usage, traceRef)
            : dispatchFailure(code, message, usage, traceRef);
    }
}
function notifyChildStarted(input, observer, child) {
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