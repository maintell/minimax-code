import { pausesQueueOnAbort } from './queue-pause-on-abort.js';
/**
 * Settles Turn ownership after AgentHost completes. AgentHost exclusively owns
 * runtime Session/history/stream projection. Pre-Host preparation explicitly
 * projects its started state and terminal failures through SessionSystem.
 */
export function createExecutionCoordinator(options) {
    return {
        startTurn: async ({ turn, request, executionStart, beforeHost, compensate }) => {
            return {
                completion: executeAgentTurn(options, {
                    turn,
                    request,
                    executionStart,
                    beforeHost,
                    compensate,
                }),
            };
        },
        failTurn: async ({ turn, error }) => ({
            completion: settlePreHostFailure(options, turn, error),
        }),
        failAdmission: async ({ admission, error }) => ({
            completion: settleFailedAdmission(options, admission, error),
        }),
        compact: async (input) => {
            let outcome;
            try {
                outcome = await options.host.compact(input);
            }
            catch (error) {
                outcome = { status: 'failed', error };
            }
            return settleCompaction(options, input.lease, outcome);
        },
    };
}
async function executeAgentTurn(options, { turn, request, executionStart, beforeHost, compensate, }) {
    let beforeCapabilityCapture;
    try {
        await executionStart;
        turn.signal.throwIfAborted();
        if (beforeHost) {
            await options.preparation.projectStarted({
                sessionId: turn.sessionId,
                turnId: turn.turnId,
                turnSequence: turn.acceptedSequence,
                eventId: `${turn.turnId}:pre-host-started`,
            });
            turn.signal.throwIfAborted();
            await beforeHost(turn.signal);
        }
        beforeCapabilityCapture = await prepareTurnStart(options, turn, request);
        turn.signal.throwIfAborted();
    }
    catch (error) {
        try {
            await compensate?.();
        }
        catch (compensationError) {
            if (turn.signal.aborted) {
                return settleAgentTurn(options, turn, request, runHost(options, turn, request));
            }
            return settlePreHostFailure(options, turn, new AggregateError([error, compensationError], 'Pre-host preparation compensation failed', {
                cause: error,
            }));
        }
        if (turn.signal.aborted) {
            return settleAgentTurn(options, turn, request, runHost(options, turn, request));
        }
        return settlePreHostFailure(options, turn, error);
    }
    return settleAgentTurn(options, turn, request, runHost(options, turn, request, beforeCapabilityCapture));
}
async function prepareTurnStart(options, turn, request) {
    turn.signal.throwIfAborted();
    if (!options.beforeStart)
        return;
    let abort;
    const cancelled = new Promise((_resolve, reject) => {
        abort = () => reject(turn.signal.reason);
        turn.signal.addEventListener('abort', abort, { once: true });
    });
    try {
        const guard = await Promise.race([
            options.beforeStart({ input: request.input, signal: turn.signal }),
            cancelled,
        ]);
        return guard ?? undefined;
    }
    finally {
        turn.signal.removeEventListener('abort', abort);
    }
}
async function runHost(options, turn, request, beforeCapabilityCapture) {
    if (turn.signal.aborted) {
        // The display input and Query may already be committed before Host entry.
        // Project their terminal fact while keeping cancelled work out of AgentHost.
        const error = await projectPreHostTerminal(options.failures, turn, turn.signal.reason, 'aborted');
        return error
            ? { status: 'failed', error }
            : { status: 'aborted', reason: String(turn.signal.reason) };
    }
    return options.host.run({
        lease: turn,
        request,
        ...(beforeCapabilityCapture ? { beforeCapabilityCapture } : {}),
    });
}
async function settleAgentTurn(options, turn, request, pending) {
    let outcome;
    try {
        outcome = await pending;
    }
    catch (error) {
        outcome = { status: 'failed', error };
    }
    const settlementError = await settleAndRelease(options, {
        turn,
        outcome: outcome.status,
        controllerTurn: turn,
        wakeQueue: outcome.status === 'completed' &&
            (outcome.waitingForUser !== true || request.provenance.source === 'thread-goal'),
    });
    return settlementError ? { status: 'failed', error: settlementError } : outcome;
}
async function settlePreHostFailure(options, turn, error) {
    const projectionError = await projectPreHostTerminal(options.failures, turn, error);
    const settlementError = await settleAndRelease(options, {
        turn,
        outcome: 'failed',
        controllerTurn: turn,
        wakeQueue: true,
    });
    return {
        status: 'failed',
        error: settlementError ?? projectionError ?? error,
    };
}
async function settleFailedAdmission(options, admission, error) {
    options.onBeginSettlement?.(admission.sessionId, admission.turnId);
    const projectionError = await projectPreHostTerminal(options.failures, admission, error);
    const settlementError = await settleAndRelease(options, {
        turn: admission,
        outcome: 'failed',
        wakeQueue: true,
    });
    return {
        status: 'failed',
        error: settlementError ?? projectionError ?? error,
    };
}
async function settleCompaction(options, turn, outcome) {
    const settlementError = await settleAndRelease(options, {
        turn,
        outcome: compactionTerminal(outcome),
        controllerTurn: turn,
        wakeQueue: true,
    });
    return settlementError ? { status: 'failed', error: settlementError } : outcome;
}
async function projectPreHostTerminal(failures, turn, error, status) {
    const input = {
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        turnSequence: turn.acceptedSequence,
        eventId: `${turn.turnId}:pre-host-${status ?? 'failed'}`,
        error,
        ...(status ? { status } : {}),
    };
    try {
        await failures.project(input);
        return undefined;
    }
    catch {
        try {
            await failures.project(input);
            return undefined;
        }
        catch (projectionError) {
            return projectionError;
        }
    }
}
async function settleAndRelease(options, input) {
    if (input.controllerTurn) {
        options.onBeginSettlement?.(input.turn.sessionId, input.turn.turnId);
        // Decision v5: fallen steering commits here — the Host outcome already
        // resolved, so the assistant tail is reconciled, and the terminal
        // repository settlement has not run yet, so concurrent admissions still
        // observe the active Turn. Committing before the settle keeps the
        // settle→complete pair adjacent: an admission racing that gap would pass
        // the repository gate and then fail controller registration, consuming
        // the queued item pre-host.
        await commitDiscardedSteering(options, input.turn);
    }
    const queuePauseCause = terminalQueuePauseCause(input);
    const settlement = await settleRepository(options.repository, {
        sessionId: input.turn.sessionId,
        turnId: input.turn.turnId,
        leaseId: input.turn.leaseId,
        outcome: input.outcome,
        ...(queuePauseCause ? { queuePauseCause } : {}),
    });
    if (settlement.error)
        return settlement.error;
    if (input.controllerTurn)
        options.controller.complete(input.controllerTurn);
    await notifyAfterSettlement(options, settlement.value, input.turn, input.outcome);
    const productSettlementError = shouldSettleProductTurn(settlement.value, input.turn)
        ? await settleRequiredProductTurn(options.turnSettlement, {
            sessionId: input.turn.sessionId,
            turnId: input.turn.turnId,
            status: input.outcome,
        })
        : undefined;
    if (shouldWakeQueue(settlement.value, productSettlementError, input.wakeQueue, input.outcome)) {
        try {
            await options.released.publish(input.turn.sessionId);
        }
        catch {
            // Durable settlement makes a later Queue wake retry-safe.
        }
    }
    if (productSettlementError)
        return productSettlementError;
    return settlement.value?.status === 'stale-owner'
        ? new Error(`Turn settlement lost ownership: ${input.turn.sessionId}/${input.turn.turnId}`)
        : undefined;
}
async function notifyAfterSettlement(options, settlement, turn, outcome) {
    if (settlement?.status !== 'settled')
        return;
    try {
        await options.afterSettlement?.({
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            outcome,
        });
    }
    catch {
        // Settlement is durable; recovery can retry any best-effort observer work.
    }
}
/**
 * Decision v5: fallen steering commits between the Host outcome (tail
 * reconciled) and the terminal settlement. Fail-open: the settlement must
 * never hang on the sink, so any misbehavior defers to the detached lane.
 */
async function commitDiscardedSteering(options, turn) {
    if (!options.steeringTeardown)
        return;
    try {
        await options.steeringTeardown.commitDiscardedBeforeRelease({
            sessionId: turn.sessionId,
            turnId: turn.turnId,
        });
    }
    catch {
        // The detached post-release lane still owns the batch.
    }
}
function terminalQueuePauseCause(input) {
    if (input.turn.busyReason !== 'turn' || input.turn.foreground !== true)
        return undefined;
    if (input.outcome === 'failed')
        return 'turn-final-failure';
    if (input.outcome === 'aborted' &&
        input.controllerTurn?.busyReason === 'turn' &&
        pausesQueueOnAbort(input.controllerTurn.signal.reason)) {
        return 'user-stop';
    }
    return undefined;
}
function shouldSettleProductTurn(settlement, turn) {
    return settlement?.status === 'settled' && turn.busyReason === 'turn';
}
function shouldWakeQueue(settlement, productSettlementError, wakeQueue, outcome) {
    return (settlement?.status !== 'stale-owner' &&
        !productSettlementError &&
        wakeQueue &&
        outcome !== 'aborted');
}
async function settleRequiredProductTurn(settlement, input) {
    if (!settlement)
        return undefined;
    try {
        await settlement.settle(input);
        return undefined;
    }
    catch {
        try {
            await settlement.settle(input);
            return undefined;
        }
        catch (error) {
            // Both attempts are spent, so nothing else will settle this Turn. Only
            // here does the product learn its Turn-scoped state is never completing.
            await abandonProductTurn(settlement, input);
            return error;
        }
    }
}
async function abandonProductTurn(settlement, input) {
    try {
        await settlement.abandon?.({ sessionId: input.sessionId, turnId: input.turnId });
    }
    catch {
        // The settle failure above stays the reported outcome for this Turn.
    }
}
async function settleRepository(repository, input) {
    try {
        return { value: await repository.settle(input) };
    }
    catch {
        try {
            return { value: await repository.settle(input) };
        }
        catch (error) {
            return { error };
        }
    }
}
function compactionTerminal(outcome) {
    if (outcome.status === 'aborted')
        return 'aborted';
    if (outcome.status === 'failed')
        return 'failed';
    return 'completed';
}
//# sourceMappingURL=execution.coordinator.js.map