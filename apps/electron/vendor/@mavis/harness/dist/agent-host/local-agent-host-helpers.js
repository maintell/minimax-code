import { assertAgentHostCapabilityAvailable } from './empty-dependencies.js';
import { resolveTurnWakeReasons } from './preparation/turn-wake-reasons.js';
/**
 * Module-scope helpers behind `LocalAgentHost`: failure capture and flattening,
 * turn lifecycle handler fan-out, event-context projection and scoped turn
 * control. None of them read or write host instance state.
 */
export const MAX_LOGGED_AGENT_HOST_FAILURES = 4;
const MAX_LOGGED_ERROR_MESSAGE_LENGTH = 1_024;
const MAX_LOGGED_ERROR_STACK_LENGTH = 4_096;
export function describeAgentHostFailure(error) {
    if (error instanceof Error) {
        return {
            name: error.name || 'Error',
            message: truncateLogText(error.message || 'Unknown error', MAX_LOGGED_ERROR_MESSAGE_LENGTH),
            ...(error.stack
                ? { stack: truncateLogText(error.stack, MAX_LOGGED_ERROR_STACK_LENGTH) }
                : {}),
        };
    }
    return {
        name: typeof error,
        message: truncateLogText(safeErrorText(error), MAX_LOGGED_ERROR_MESSAGE_LENGTH),
    };
}
function safeErrorText(error) {
    try {
        return String(error);
    }
    catch {
        return 'Unknown non-Error failure';
    }
}
function truncateLogText(value, maximum) {
    return value.length <= maximum ? value : `${value.slice(0, maximum)}…`;
}
export function bindTurnYield(control, kernel) {
    return control ? control.bindKernel(kernel) : kernel;
}
export async function capture(operation) {
    try {
        return success(await operation());
    }
    catch (error) {
        return { ok: false, error };
    }
}
export function captureSync(operation) {
    try {
        return success(operation());
    }
    catch (error) {
        return { ok: false, error };
    }
}
function success(value) {
    return { ok: true, value };
}
function compactFailures(results) {
    return results.flatMap((result) => (result.ok ? [] : flattenFailure(result.error)));
}
export function settleCapturedExecution(runner, lane) {
    if (!runner.ok)
        return { ok: false, failures: compactFailures([runner, lane]) };
    if (!lane.ok) {
        return {
            ok: false,
            failures: [...failedOutcomeFailures(runner.value), ...compactFailures([lane])],
        };
    }
    return { ok: true, outcome: runner.value };
}
export function failedOutcomeFailures(outcome) {
    return outcome.status === 'failed' ? [outcome.error] : [];
}
export function flattenFailure(error) {
    return error instanceof AggregateError ? error.errors.flatMap(flattenFailure) : [error];
}
export function throwFailures(failures, message) {
    const unique = [...new Set(failures)];
    if (unique.length === 1)
        throw unique[0];
    throw new AggregateError(unique, message);
}
export async function runTurnStartHandlers(handlers, context, isOrdinaryInputTurn, isUserAuthoredInput) {
    await runSequential(handlers, (handler) => handler({
        sessionId: context.sessionId,
        turnId: context.turnId,
        agentName: context.agentName,
        workspaceDir: context.workspaceDir,
        history: context.history,
        userInput: context.userInput,
        isOrdinaryInputTurn,
        isUserAuthoredInput,
    }, context));
}
export async function collectTurnEndHandlerFailures(handlers, context, reason, index = 0) {
    const handler = handlers[index];
    if (!handler)
        return [];
    const result = await capture(async () => {
        await handler({
            sessionId: context.sessionId,
            turnId: context.turnId,
            agentName: context.agentName,
            workspaceDir: context.workspaceDir,
            reason,
        }, context);
    });
    const remaining = await collectTurnEndHandlerFailures(handlers, context, reason, index + 1);
    return result.ok ? remaining : [result.error, ...remaining];
}
async function runSequential(values, visit, index = 0) {
    const value = values[index];
    if (value === undefined)
        return;
    await visit(value);
    await runSequential(values, visit, index + 1);
}
export function scopeTurnControl(dependencies, lease) {
    const control = dependencies.turnControl.scope(lease);
    assertAgentHostCapabilityAvailable('turn-control', [
        control?.drainSteering,
        control?.tryBeginClose,
        control?.cancelClose,
        control?.sealAbnormalTerminal,
        control?.openToolResultTail,
        control?.closeAndClaimToolResultTail,
        control?.ackToolResultTail,
    ].every((operation) => typeof operation === 'function'));
    return control;
}
export function createBaseAgentEventContext(input) {
    return {
        sessionId: input.lease.sessionId,
        turnId: input.lease.turnId,
        turnSequence: input.lease.acceptedSequence,
    };
}
export function createAgentEventContext(input) {
    const base = createBaseAgentEventContext(input);
    return {
        ...base,
        ...(input.request.queueItemIds ? { queueItemIds: [...input.request.queueItemIds] } : {}),
        provenance: {
            source: input.request.provenance.source,
            ...(input.request.provenance.sourceContext
                ? { sourceContext: { ...input.request.provenance.sourceContext } }
                : {}),
            routingFingerprint: input.request.provenance.routingFingerprint,
        },
        wakeReasons: resolveTurnWakeReasons(input.request),
        ...(input.request.clientRequestId ? { clientRequestId: input.request.clientRequestId } : {}),
    };
}
export function turnTimingField(turnTiming) {
    return turnTiming ? { turnTiming } : {};
}
export function uniqueTaskIds(values) {
    return [
        ...new Set(values.filter((value) => typeof value === 'string' && value.trim().length > 0)),
    ];
}
//# sourceMappingURL=local-agent-host-helpers.js.map