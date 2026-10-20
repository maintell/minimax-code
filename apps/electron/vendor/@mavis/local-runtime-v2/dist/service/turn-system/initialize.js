import { AsyncLocalStorage } from 'node:async_hooks';
import { createExecutionCoordinator, } from './execution/execution.coordinator.js';
import { createSteerSessionService } from './execution/steering/steer-session.service.js';
import { createTurnController } from './execution/turn-controller/turn.controller.js';
import { createTurnExecutionService } from './execution/turn-execution.service.js';
import { createSessionOperationGate } from './lifecycle/session-operation-gate.js';
import { createSessionTurnDeletionService } from './lifecycle/session-turn-deletion.js';
import { createTurnReleasedSignal, } from './lifecycle/turn-released-signal.js';
import { createTurnFactProjector } from './persistence/turn-fact-projector.js';
import { createTurnRepository } from './persistence/turn.repository.js';
import { createQueueDispatcher } from './queue.dispatcher.js';
import { createQueuedTurnCompletionRegistry } from './queued-turn-completion.js';
import { createSteeringRequeue, } from './execution/steering/steering-requeue.js';
import { createSteeringTeardownCommit } from './execution/steering/steering-teardown-commit.js';
import { createTurnSubmissionService } from './turn-submission.service.js';
import { createHistoryMutationCapability } from './lifecycle/history-mutation-capability.js';
import { createUserMessageId, SessionMaintenanceService } from '../session-system/index.js';
import { createTurnContinuationService } from './execution/turn-continuation.service.js';
/** Initializes one production Turn graph over the SessionSystem persistence owner. */
export async function initializeTurnSystem(options) {
    const repository = createRuntimeTurnRepository(options);
    const released = createTurnReleasedSignal();
    const steeringRequeue = createRuntimeSteeringRequeue(options, released);
    const { controller, completions } = createQueuedTurnControl(options, repository, steeringRequeue);
    const operations = createSessionOperationGate();
    // A Session lifecycle fence owns the in-process admission gate, but its archive commit still
    // needs the persistent maintenance lease. Async context makes that re-entry owner-scoped while
    // unrelated Turns and mutations remain blocked.
    const exclusiveSession = new AsyncLocalStorage();
    const maintenance = createOperationGatedMaintenance(repository, operations, released, (sessionId) => exclusiveSession.getStore() === sessionId);
    const sessionEndMaintenance = new SessionMaintenanceService(maintenance);
    const host = await options.createHost({
        turnControl: controller,
        turnFacts: createTurnFactProjector(repository),
        pluginHookSessionOwnership: {
            prepare: (input) => repository.preparePluginHookSessionOwnership(input),
            activate: (input) => repository.activatePluginHookSessionOwnership(input),
        },
    });
    const queue = options.sessions.queue.createDispatch(repository);
    const subagentSiblingWake = createSubagentSiblingWake(options.subagentConcurrency);
    const coordinator = createExecutionCoordinator({
        host,
        repository,
        controller,
        preparation: options.sessions.agentProjection.preparation,
        failures: options.sessions.agentProjection.failures,
        onBeginSettlement: completions.beginSettlement,
        released,
        ...(subagentSiblingWake.afterSettlement
            ? { afterSettlement: subagentSiblingWake.afterSettlement }
            : {}),
        ...(options.beforeStart ? { beforeStart: options.beforeStart } : {}),
        // Decision v5: fallen steering commits before the Turn releases Session
        // ownership, so a stop-then-send Turn reads the rows (TS-75).
        steeringTeardown: steeringRequeue,
        ...(options.turnSettlement ? { turnSettlement: options.turnSettlement } : {}),
    });
    const execution = createTurnExecutionService({
        repository,
        controller,
        coordinator,
        preparation: options.sessions.agentProjection.preparation,
        failures: options.sessions.agentProjection.failures,
        operations,
        onInterruptSendReleased: (sessionId) => released.publish(sessionId),
        sessions: {
            has: (sessionId) => options.sessions.sessions.repository.has(sessionId),
        },
        ...turnExecutionOverrides(options),
    });
    const continuation = createRuntimeTurnContinuation(options, execution);
    const messageDelivery = options.createMessageDelivery({
        execution: { execute: (input) => execution.submit(input) },
    });
    const trustedMessageDelivery = options.createMessageDelivery({
        execution: { execute: (input) => execution.submitTrusted(input) },
    });
    const recovery = createRuntimeRecoveryCoordinator(options, repository, subagentSiblingWake);
    const dispatcher = createQueueDispatcher({
        queue,
        executor: messageDelivery.queue,
        onPreparing: completions.prepareExecution,
        onExecution: (claim, result) => completions.observe(claim, result),
        isCancellationRequested: (item) => item.requestedTurnId !== undefined &&
            completions.cancellationReason(item.sessionId, item.requestedTurnId) !== undefined,
        ...queueSelectionOverrides(options),
        recoverState: recovery.recoverState,
    });
    subagentSiblingWake.bind(queue, dispatcher, recovery.requestSubagentRetry, recovery.recoverSubagentTaskOwners);
    recovery.bind(dispatcher);
    const unsubscribeQueueFacts = options.sessions.queue.facts.subscribe(completions.handleFacts);
    const unsubscribeSubagentQueueFacts = options.subagentConcurrency
        ? options.sessions.queue.facts.subscribe(subagentSiblingWake.handleFacts)
        : () => undefined;
    const unsubscribeReleased = released.subscribe((sessionId) => dispatcher.dispatch(sessionId));
    const deletion = createSessionTurnDeletionService({
        repository,
        controller,
        dispatcher,
        operations,
        beginProcessDeletion: (sessionId) => options.sessions.sessions.deletion.begin(sessionId),
        completeProcessDeletion: (sessionId) => options.sessions.sessions.deletion.complete(sessionId),
        disposeRuntimeSession: options.disposeRuntimeSession,
    });
    const steer = createSteerSessionService({
        turns: execution,
        activation: messageDelivery.activation,
        receipts: repository,
        ...(options.sessionClio ? { sessionClio: options.sessionClio } : {}),
        ...(options.nowMs ? { nowMs: options.nowMs } : {}),
    });
    const submissionOptions = turnSubmissionOptions(options);
    const submission = createTurnSubmissionService({
        activation: messageDelivery.activation,
        queue: options.sessions.queue.submission,
        dispatcher,
        completions,
        activeTurnId: (sessionId) => execution.activeTurnId(sessionId),
        ...submissionOptions,
    });
    const trustedSubmission = createTurnSubmissionService({
        activation: trustedMessageDelivery.activation,
        queue: options.sessions.queue.submission,
        dispatcher,
        completions,
        activeTurnId: (sessionId) => execution.activeTurnId(sessionId),
        ...submissionOptions,
    });
    const historyMutation = createHistoryMutationCapability({
        sessions: options.sessions.sessions.historyMutation,
        forkProjections: options.forkProjections,
        rewindProjections: options.rewindProjections,
        activeTurnId: (sessionId) => execution.activeTurnId(sessionId),
        ...(options.onTurnDiffRewindSkipped
            ? { onTurnDiffRewindSkipped: options.onTurnDiffRewindSkipped }
            : {}),
    });
    const turns = createTurnFacade({
        execution,
        completions,
        historyMutation,
        submission,
        dispatcher,
        steer,
        continuation,
        deletion,
        onQueueWakeFailure: options.onQueueWakeFailure,
    });
    let readyPromise;
    let closed = false;
    let closePromise;
    return {
        turns,
        ...subagentOccupancyCapability(options.subagentConcurrency),
        sessionLifecycle: {
            runExclusive: async (sessionId, operation) => {
                const lease = operations.tryAcquireExclusive(sessionId);
                if (!lease)
                    throw new Error(`Session lifecycle operation is already active: ${sessionId}`);
                try {
                    return await exclusiveSession.run(sessionId, operation);
                }
                finally {
                    lease.release();
                }
            },
            tryRunExclusive: (sessionId, operation) => sessionEndMaintenance.tryRunExclusive(sessionId, operation),
        },
        pluginHookSessionOwnership: pluginHookSessionOwnership(repository),
        queueSteer: createRuntimeQueueSteer(queue, completions),
        inspection: {
            activeTurnId: (sessionId) => execution.activeTurnId(sessionId),
            hasPendingUserSteering: (sessionId) => controller.hasPendingUserSteering(sessionId),
            activeTurn: async (sessionId) => {
                const active = await repository.findActiveTurn(sessionId);
                return active
                    ? {
                        ...active,
                        locallyOwned: execution.activeTurnId(sessionId) === active.turnId,
                    }
                    : undefined;
            },
            latestTurnActivity: (sessionId) => repository.findLatestTurnActivity(sessionId),
        },
        processLifecycle: createProcessLifecycle(controller),
        maintenance,
        receipts: receiptReader(repository),
        trustedEditSubmission: createTrustedEditSubmission(trustedSubmission),
        ready: () => {
            readyPromise ??= closed ? Promise.resolve() : recovery.recoverPending();
            return readyPromise;
        },
        close: () => {
            if (closePromise)
                return closePromise;
            closed = true;
            unsubscribeReleased();
            unsubscribeQueueFacts();
            unsubscribeSubagentQueueFacts();
            completions.close();
            // drain() must persist the aborted Turns' steering requeues before DB close.
            closePromise = settleShutdown([
                recovery.close(),
                dispatcher.close(),
                controller.close(),
                steeringRequeue.drain(),
                ...(readyPromise ? [readyPromise] : []),
            ]);
            return closePromise;
        },
    };
}
function createRuntimeQueueSteer(queue, completions) {
    return {
        prepareDelivery: (claim, turnId) => {
            completions.prepareExecution(claim, turnId);
            return queue.prepareDelivery({
                sessionId: claim.sessionId,
                claimId: claim.claimId,
                turnId,
            });
        },
        observe: (claim, result) => completions.observe(claim, result),
        claim: ({ sessionId, itemId }) => queue.claimNext({ sessionId, itemId }),
        consume: async (claim, outcome) => {
            await queue.consume({
                sessionId: claim.sessionId,
                claimId: claim.claimId,
                reason: outcome.mode === 'activated' ? 'accepted' : 'injected',
            });
        },
        release: (claim) => queue.release({ sessionId: claim.sessionId, claimId: claim.claimId }),
    };
}
function subagentOccupancyCapability(subagentConcurrency) {
    return subagentConcurrency
        ? { subagentOccupancy: (parentSessionId) => subagentConcurrency.occupancy(parentSessionId) }
        : {};
}
function createSubagentSiblingWake(subagentConcurrency) {
    let wakeQueuedSiblings;
    let recoverQueuedTaskChildren;
    let requestRecovery;
    const afterSettlement = subagentConcurrency
        ? async ({ sessionId }) => {
            await wakeQueuedSiblings?.(sessionId);
        }
        : undefined;
    return {
        ...(afterSettlement ? { afterSettlement } : {}),
        bind: (queue, dispatcher, nextRequestRecovery, nextRecoverTaskOwners) => {
            if (!subagentConcurrency)
                return;
            requestRecovery = nextRequestRecovery;
            wakeQueuedSiblings = (releasedSessionId) => subagentConcurrency.wakeQueuedSiblings({
                releasedSessionId,
                queue,
                dispatch: (sessionId) => dispatcher.dispatch(sessionId),
            });
            recoverQueuedTaskChildren = () => subagentConcurrency.recoverQueuedTaskChildren({
                queue,
                dispatch: (sessionId) => dispatcher.dispatch(sessionId),
                recoverTaskOwners: nextRecoverTaskOwners,
            });
        },
        recoverQueuedTaskChildren: async () => (await recoverQueuedTaskChildren?.()) ?? false,
        handleFacts: (facts) => {
            if (facts.some((fact) => fact.kind === 'requeued' &&
                fact.admissionReason === 'policy:subagent:concurrency-limit')) {
                requestRecovery?.();
            }
        },
    };
}
/** Optional Queue-selection policies the product owner may leave unbound. */
function queueSelectionOverrides(options) {
    return {
        ...(options.classifyQueuedItem ? { classifyQueuedItem: options.classifyQueuedItem } : {}),
        ...(options.shouldYieldFifoPosition
            ? { shouldYieldFifoPosition: options.shouldYieldFifoPosition }
            : {}),
    };
}
function pluginHookSessionOwnership(repository) {
    return {
        latest: (sessionId) => repository.findLatestPluginHookSessionOwnership(sessionId),
        tryClaimSessionEnd: (input) => repository.tryClaimPluginHookSessionEnd(input),
        completeSessionEnd: (input) => repository.completePluginHookSessionEnd(input),
    };
}
function turnExecutionOverrides(options) {
    return {
        ...(options.submissionPreparation
            ? { submissionPreparation: options.submissionPreparation }
            : {}),
        ...(options.nowMs ? { nowMs: options.nowMs } : {}),
        ...(options.makeTurnId ? { makeTurnId: options.makeTurnId } : {}),
        ...(options.userStop ? { userStop: options.userStop } : {}),
        ...(options.logger ? { logger: options.logger } : {}),
    };
}
function createRuntimeSteeringRequeue(options, released) {
    const projectDisplay = options.commitSteeringTeardownProjection;
    return createSteeringRequeue({
        queue: options.sessions.queue.submission,
        released,
        ...(projectDisplay
            ? {
                teardown: createSteeringTeardownCommit({
                    projectDisplay,
                    canonicalHistory: options.sessions.canonicalHistory,
                    ...(options.nowMs ? { nowMs: options.nowMs } : {}),
                    ...(options.logger ? { logger: options.logger } : {}),
                }),
            }
            : {}),
        ...(options.logger ? { logger: options.logger } : {}),
    });
}
function createRuntimeTurnContinuation(options, execution) {
    return createTurnContinuationService({
        history: options.sessions.canonicalHistory,
        execution,
    });
}
function turnSubmissionOptions(options) {
    return {
        ...(options.makeTurnId ? { makeTurnId: options.makeTurnId } : {}),
        ...(options.onQueueWakeFailure ? { onQueueWakeFailure: options.onQueueWakeFailure } : {}),
        ...(options.resolveChannelInputModel
            ? { resolveChannelInputModel: options.resolveChannelInputModel }
            : {}),
        ...(options.queueSubmissionRejections
            ? { queueSubmissionRejections: options.queueSubmissionRejections }
            : {}),
        ...(options.sessionClio ? { sessionClio: options.sessionClio } : {}),
    };
}
function createRuntimeTurnRepository(options) {
    return createTurnRepository({
        db: options.db,
        priorityFence: options.sessions.queue.priorityFence,
        sessionAdmission: options.sessions.sessions.deletion.turnAdmission,
        ...(options.admissionPolicy ? { admissionPolicy: options.admissionPolicy } : {}),
        ...(options.nowMs ? { nowMs: options.nowMs } : {}),
        ...(options.makeLeaseId ? { makeLeaseId: options.makeLeaseId } : {}),
        ...(options.makeDeletionOwnerId ? { makeDeletionOwnerId: options.makeDeletionOwnerId } : {}),
        ...(options.isLeaseOwnerAlive ? { isLeaseOwnerAlive: options.isLeaseOwnerAlive } : {}),
        ...(options.isLeaseOwnerCurrent ? { isLeaseOwnerCurrent: options.isLeaseOwnerCurrent } : {}),
    });
}
function createRuntimeRecoveryCoordinator(options, repository, subagentQueueWake) {
    const pendingDeletionSessionIds = new Set();
    let recoverDispatcher;
    let inFlightRecovery;
    let recoveryTimer;
    let liveSessionsRemain = false;
    let pendingTaskOwners = false;
    let retryDesktopSubagentQueue = false;
    let lastTaskRecoveryState;
    const pendingRecoveredTurnIds = new Set();
    let closed = false;
    const schedule = () => {
        if (closed || recoveryTimer)
            return;
        const delayMs = Math.max(1, Math.floor(options.runtimeRecoveryRetryMs ?? 10_000));
        recoveryTimer = setTimeout(() => void runScheduledRecovery(), delayMs);
        recoveryTimer.unref?.();
    };
    const resumePendingDeletions = async () => {
        for (const sessionId of [...pendingDeletionSessionIds]) {
            if (closed)
                return;
            if (!options.resumeSessionDeletion)
                continue;
            try {
                await options.resumeSessionDeletion(sessionId);
                pendingDeletionSessionIds.delete(sessionId);
            }
            catch (error) {
                options.onRuntimeRecoveryFailure?.({ sessionId, error });
            }
        }
    };
    const reconcileRecoveredTaskTurns = async (force) => {
        if (!force && pendingRecoveredTurnIds.size === 0)
            return;
        pendingTaskOwners = (await options.onRuntimeRecovery?.([...pendingRecoveredTurnIds])) === true;
        pendingRecoveredTurnIds.clear();
    };
    const recoverState = async () => {
        const restarted = await repository.recoverProcessRestart({
            processStartedAtMs: options.processStartedAtMs,
        });
        for (const fact of restarted.terminalFacts)
            pendingRecoveredTurnIds.add(fact.turnId);
        for (const sessionId of restarted.pendingDeletionSessionIds ?? []) {
            pendingDeletionSessionIds.add(sessionId);
        }
        const protectedSessionIds = [...(restarted.liveSessionIds ?? []), ...pendingDeletionSessionIds];
        await options.sessions.sessions.recovery.recoverPreviousProcess({
            processStartedAtMs: options.processStartedAtMs,
            ...(protectedSessionIds.length > 0 ? { protectedSessionIds } : {}),
        });
        const taskRecoveryState = JSON.stringify([...protectedSessionIds].sort());
        if (taskRecoveryState !== lastTaskRecoveryState || pendingRecoveredTurnIds.size > 0) {
            await reconcileRecoveredTaskTurns(true);
            lastTaskRecoveryState = taskRecoveryState;
        }
        else if (pendingTaskOwners) {
            pendingTaskOwners = (await options.pollRuntimeRecovery?.()) === true;
        }
        liveSessionsRemain = (restarted.liveSessionIds?.length ?? 0) > 0;
    };
    const runRecovery = async () => {
        if (!recoverDispatcher)
            throw new Error('Runtime recovery dispatcher is not bound');
        await recoverDispatcher();
        if (closed)
            return;
        retryDesktopSubagentQueue = false;
        retryDesktopSubagentQueue ||= await subagentQueueWake.recoverQueuedTaskChildren();
        await resumePendingDeletions();
        if (liveSessionsRemain ||
            pendingTaskOwners ||
            pendingDeletionSessionIds.size > 0 ||
            retryDesktopSubagentQueue) {
            schedule();
        }
    };
    const recoverPending = async () => {
        const recovery = runRecovery();
        inFlightRecovery = recovery;
        try {
            await recovery;
        }
        finally {
            inFlightRecovery = undefined;
        }
    };
    const runScheduledRecovery = async () => {
        recoveryTimer = undefined;
        if (closed)
            return;
        try {
            await recoverPending();
        }
        catch (error) {
            options.onRuntimeRecoveryFailure?.({ sessionId: '<runtime>', error });
            schedule();
        }
    };
    const recoverSubagentTaskOwners = async (sessionIds) => {
        if (sessionIds.length === 0)
            return;
        const restarted = await repository.recoverProcessRestart({
            processStartedAtMs: currentRecoveryObservationMs(options),
            sessionIds,
        });
        for (const fact of restarted.terminalFacts)
            pendingRecoveredTurnIds.add(fact.turnId);
        await reconcileRecoveredTaskTurns(false);
    };
    return {
        recoverState,
        recoverPending,
        bind: (dispatcher) => {
            recoverDispatcher = () => dispatcher.recoverPending({ processStartedAtMs: options.processStartedAtMs });
        },
        requestSubagentRetry: () => {
            retryDesktopSubagentQueue = true;
            schedule();
        },
        recoverSubagentTaskOwners,
        close: async () => {
            closed = true;
            if (recoveryTimer)
                clearTimeout(recoveryTimer);
            recoveryTimer = undefined;
            if (inFlightRecovery)
                await inFlightRecovery;
        },
    };
}
function currentRecoveryObservationMs(options) {
    const observedAtMs = options.nowMs?.() ?? Date.now();
    if (!Number.isFinite(observedAtMs)) {
        throw new TypeError('runtime recovery observation time must be finite');
    }
    return Math.max(options.processStartedAtMs, observedAtMs);
}
function createTrustedEditSubmission(trustedSubmission) {
    return {
        submit: async (request) => {
            const messageKey = `edit:${request.operationId}`;
            const userMessageId = createUserMessageId({ sessionId: request.sessionId, messageKey });
            const result = await trustedSubmission.submit({
                sessionId: request.sessionId,
                input: { text: request.content, attachments: request.attachments },
                allowQueue: false,
                provenance: {
                    source: 'conversation-mutation',
                    routingFingerprint: `conversation-edit:${request.operationId}`,
                    sourceContext: { clientRequestId: request.operationId },
                },
                clientRequestId: request.operationId,
                userMessageId,
                delivery: {
                    messageKey,
                    userMessageId,
                    ...(request.displayAttachments ? { displayAttachments: request.displayAttachments } : {}),
                },
            });
            return { ...result, userMessageId };
        },
    };
}
/** Keep pending Queue cancellation and future in-process ownership in one graph. */
function createQueuedTurnControl(options, repository, steeringRequeue) {
    const completions = createQueuedTurnCompletionRegistry();
    const controller = createTurnController({
        renew: repository.renew,
        onRegister: completions.beginExecution,
        onSteeringDiscarded: (batch) => steeringRequeue.discard(batch),
        ...(options.logger ? { logger: options.logger } : {}),
    });
    return { controller, completions };
}
function createTurnFacade(input) {
    return {
        prepareSideChat: (request) => input.historyMutation.prepareSideChat(request),
        fork: (request) => input.historyMutation.fork(request),
        rewind: (request) => input.historyMutation.rewind(request),
        submit: (request) => input.submission.submit(request),
        resumeUserInput: (request) => input.submission.resumeUserInput(request),
        inspectContinuation: (sessionId) => input.continuation.inspect(sessionId),
        continueTurn: (request) => input.continuation.continueTurn(request),
        requestCompaction: (request) => input.execution.requestCompaction(request),
        abort: async (request) => {
            const pending = request.turnId
                ? input.completions.requestCancellation(request.sessionId, request.turnId, request.reason)
                : false;
            if (pending)
                queueMicrotask(() => void wakeCancelledQueue(input.dispatcher, input, request.sessionId));
            const result = await abortQueuedExecution(input, request);
            if (pending &&
                request.turnId &&
                input.completions.isPending(request.sessionId, request.turnId) &&
                (result.status === 'not-running' || result.status === 'turn-mismatch')) {
                await request.onAccepted?.();
                return { status: 'aborted', turnId: request.turnId };
            }
            return result;
        },
        steer: (request) => input.steer.steer(request),
        dispatchSessionQueue: (sessionId) => input.dispatcher.continuePaused(sessionId),
        dispatchQueue: (sessionId) => input.dispatcher.dispatch(sessionId),
        sessionDeletion: (sessionId, cleanup) => input.deletion.run(sessionId, cleanup),
    };
}
/** Retried Queue work keeps the original caller identity while its controller owns a new Turn. */
async function abortQueuedExecution(input, request) {
    const turnId = request.turnId
        ? input.completions.executionTurnId(request.sessionId, request.turnId)
        : undefined;
    const result = await input.execution.abort(turnId ? { ...request, turnId } : request);
    return turnId && request.turnId && 'turnId' in result
        ? { ...result, turnId: request.turnId }
        : result;
}
async function wakeCancelledQueue(dispatcher, options, sessionId) {
    // A cancellation can race the final await of claim release. Request another
    // drain now; the dispatcher's wake counter serializes it after that release.
    try {
        await dispatcher.dispatch(sessionId);
    }
    catch (error) {
        try {
            options.onQueueWakeFailure?.({ sessionId, error });
        }
        catch {
            // Diagnostics cannot turn a handled wake failure into an unhandled rejection.
        }
    }
}
function createOperationGatedMaintenance(repository, operations, released, isExclusiveSessionOwner) {
    const permits = new Map();
    const ownedFencePermit = { release: () => undefined };
    return {
        tryAcquireSessionMaintenance: async (sessionId) => {
            const ownsExclusiveSession = isExclusiveSessionOwner(sessionId);
            const permit = ownsExclusiveSession ? ownedFencePermit : operations.tryEnter(sessionId);
            if (!permit)
                return undefined;
            try {
                const lease = await repository.tryAcquireSessionMaintenance(sessionId);
                if (!lease) {
                    permit.release();
                    return undefined;
                }
                permits.set(maintenanceLeaseKey(lease), permit);
                return lease;
            }
            catch (error) {
                permit.release();
                throw error;
            }
        },
        renewSessionMaintenance: (lease) => repository.renewSessionMaintenance(lease),
        releaseSessionMaintenance: async (lease) => {
            const key = maintenanceLeaseKey(lease);
            const permit = permits.get(key);
            try {
                await repository.releaseSessionMaintenance(lease);
            }
            finally {
                permits.delete(key);
                permit?.release();
            }
            await released.publish(lease.sessionId);
        },
    };
}
function maintenanceLeaseKey(lease) {
    return `${lease.sessionId}\0${lease.leaseId}`;
}
async function settleShutdown(operations) {
    const results = await Promise.allSettled(operations);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure)
        throw failure.reason;
}
function createProcessLifecycle(controller) {
    return {
        beginDrain: () => controller.beginDrain(),
        tryBeginDrainIfIdle: () => controller.tryBeginDrainIfIdle(),
    };
}
function receiptReader(repository) {
    return {
        findReceipt: (turnId) => repository.findReceipt(turnId),
        findClientRequestBindings: (input) => repository.findClientRequestBindings(input),
    };
}
//# sourceMappingURL=initialize.js.map