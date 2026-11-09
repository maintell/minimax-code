import { pausesQueueOnAbort, wakesQueueOnAbort } from './queue-pause-on-abort.js';
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
            options.beforeStart({
                input: request.input,
                sessionId: turn.sessionId,
                turnId: turn.turnId,
                source: request.provenance.source,
                signal: turn.signal,
            }),
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
    let settlementStarted = false;
    try {
        outcome = await pending;
    }
    catch (error) {
        outcome = { status: 'failed', error };
        // Close admission cancellation before the failure projection.
        options.onBeginSettlement?.(turn.sessionId, turn.turnId);
        settlementStarted = true;
        await projectPostHostFailure(options, turn, error);
    }
    const settlementOptions = settlementStarted
        ? { ...options, onBeginSettlement: undefined }
        : options;
    const settlementError = await settleAndRelease(settlementOptions, {
        turn,
        outcome: outcome.status,
        controllerTurn: turn,
        wakeQueue: outcome.status === 'completed'
            ? outcome.waitingForUser !== true || request.provenance.source === 'thread-goal'
            : outcome.status === 'aborted' && wakesQueueOnAbort(turn.signal.reason),
    });
    return settlementError ? { status: 'failed', error: settlementError } : outcome;
}
/**
 * A rejected Host run may have died before writing its own terminal Session
 * state (for example when a full disk fails that write), which would leave the
 * Session `started` forever. Project the failure once more while this Turn
 * still holds its durable lock and in-process owner. When the Host already
 * wrote its terminal, the Session state fence rejects this write as a
 * conflict: an expected no-op that never changes the Turn outcome.
 */
async function projectPostHostFailure(options, turn, error) {
    try {
        await options.failures.project({
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            turnSequence: turn.acceptedSequence,
            eventId: `${turn.turnId}:post-host-failed`,
            error,
        });
    }
    catch (projectionError) {
        try {
            options.logger?.debug?.({
                event: 'turn_post_host_failure_projection_skipped',
                session_id: turn.sessionId,
                turn_id: turn.turnId,
                error: describeError(projectionError),
            }, '[local-runtime-v2] Post-Host failure projection skipped');
        }
        catch {
            // Diagnostics must never change the Turn outcome.
        }
    }
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
    if (settlement.error) {
        await releaseUnsettledTurn(options, input, settlement.error);
        return settlement.error;
    }
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
    if (shouldWakeQueue(settlement.value, productSettlementError, input)) {
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
/**
 * Terminal persistence failed after its retry. The repository keeps a pending
 * settlement that the next admission recovers inside its own transaction,
 * failing the Turn and applying the same Queue pause, so the durable lock heals
 * itself. The in-process owner has no such recovery: left registered, a stop
 * times out and every later send or rewind of the Session fails until the
 * Runtime restarts. Release it here unless discarded steering of this Turn is
 * still unpersisted. No Queue wake: nothing durable changed, and the next
 * admission must recover the lock and pause first.
 */
async function releaseUnsettledTurn(options, input, error) {
    const release = !hasUnpersistedSteering(options, input.turn);
    // The decision and the release stay synchronous: no await in between.
    if (release && input.controllerTurn)
        options.controller.complete(input.controllerTurn);
    logSettlementPersistenceFailure(options, input, error, release);
    if (release && input.turn.busyReason === 'turn' && options.turnSettlement) {
        await abandonProductTurn(options.turnSettlement, input.turn);
    }
}
function hasUnpersistedSteering(options, turn) {
    const steering = options.steeringTeardown;
    if (!steering?.hasPendingForTurn)
        return false;
    try {
        return steering.hasPendingForTurn({ sessionId: turn.sessionId, turnId: turn.turnId });
    }
    catch {
        // Unknown durability: keep the owner rather than let the next Turn overtake it.
        return true;
    }
}
function logSettlementPersistenceFailure(options, input, error, ownerReleased) {
    const logger = options.logger;
    if (!logger)
        return;
    try {
        const fields = {
            event: 'turn_settlement_persist_failed',
            session_id: input.turn.sessionId,
            turn_id: input.turn.turnId,
            busy_reason: input.turn.busyReason,
            outcome: input.outcome,
            owner_released: ownerReleased,
            error: describeError(error),
        };
        const message = '[local-runtime-v2] Turn settlement persistence failed';
        if (logger.error)
            logger.error(fields, message);
        else
            logger.warn(fields, message);
    }
    catch {
        // Diagnostics must never change the Turn outcome.
    }
}
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
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
function shouldWakeQueue(settlement, productSettlementError, input) {
    return (settlement?.status !== 'stale-owner' &&
        !productSettlementError &&
        input.wakeQueue &&
        (input.outcome !== 'aborted' ||
            (input.controllerTurn !== undefined && wakesQueueOnAbort(input.controllerTurn.signal.reason))));
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