import { randomUUID } from 'node:crypto';
import {} from '../../service/session-system/index.js';
import {} from '../../service/turn-system/index.js';
import { WorkspaceInitialSnapshotGateError, } from './workspace-snapshot-gate.js';
const directSendObservations = new WeakSet();
/** Adds send_msg SSE and Session activation callbacks around no-Queue submit. */
export class DirectSendDeliveryService {
    options;
    // ponytail: failed cleanup tokens live until replay; bound this map if failures become sustained.
    pendingQueuePauseCleanups = new Map();
    constructor(options) {
        this.options = options;
    }
    async open(input) {
        const workspaceGate = this.options.workspaceGate;
        const reservation = this.options.stream.reserve(input.sessionId);
        try {
            const steerSend = this.openSteerIntentSend(input, reservation);
            if (steerSend)
                return await steerSend;
            const result = await this.options.turns.submit({
                sessionId: input.sessionId,
                input: input.input,
                ...(input.outputContract ? { outputContract: input.outputContract } : {}),
                ...(input.executionDeadlineAtMs !== undefined
                    ? { executionDeadlineAtMs: input.executionDeadlineAtMs }
                    : {}),
                allowQueue: false,
                provenance: input.provenance,
                ...(input.requestedTurnId ? { requestedTurnId: input.requestedTurnId } : {}),
                ...(input.clientIntent ? { clientIntent: input.clientIntent } : {}),
                ...(input.resumePausedQueue ? { resumePausedQueue: true } : {}),
                delivery: {
                    ...directSendDisplayOptions(input),
                    onAccepted: ({ turnId }) => reservation.bindTurn(turnId),
                    ...(workspaceGate
                        ? {
                            preDelivery: {
                                accept: async () => {
                                    try {
                                        await workspaceGate.prepareForSessionStart(input.sessionId);
                                    }
                                    catch (cause) {
                                        throw new WorkspaceInitialSnapshotGateError({ cause });
                                    }
                                },
                            },
                        }
                        : {}),
                    beforeStart: async () => {
                        await retryOnce(() => this.options.activation.prepareForUserActivation(input.sessionId));
                    },
                },
            });
            if (!result.accepted) {
                reservation.discardIfEmpty();
                return classifyQueuePauseBlock(this.options.queue, input.sessionId, result);
            }
            observeCompletion(result.completion, reservation.complete);
            return {
                accepted: true,
                turnId: result.turnId,
                completion: result.completion,
                frames: reservation.source,
            };
        }
        catch (error) {
            reservation.discardIfEmpty();
            throw error;
        }
    }
    /** Routes steer client intents to their authoritative steer-or-activate flow. */
    openSteerIntentSend(input, reservation) {
        if (input.executionDeadlineAtMs !== undefined &&
            (isPausedQueueSend(input) || isComposerSteerSend(input.clientIntent))) {
            reservation.discardIfEmpty();
            return Promise.resolve({ accepted: false, reason: 'invalid-input' });
        }
        const changesPlanMode = input.clientIntent === 'plan-entry' || input.clientIntent === 'plan-exit';
        if (isPausedQueueSend(input) && !changesPlanMode) {
            return this.openPausedQueueSend(input, reservation);
        }
        if (isComposerSteerSend(input.clientIntent)) {
            return this.openComposerSteerSend(input, reservation);
        }
        return undefined;
    }
    /**
     * Composer steer-intent send: joins the running Turn instead of queueing;
     * an idle Session falls back to normal activation semantics.
     */
    async openComposerSteerSend(input, reservation) {
        const workspaceGate = this.options.workspaceGate;
        const idempotencyKey = input.requestedTurnId ?? `composer-steer:${randomUUID()}`;
        const result = await this.options.turns.steer({
            sessionId: input.sessionId,
            input: input.input,
            provenance: input.provenance,
            producerId: 'composer-steer',
            idempotencyKey,
            modelSelectionScope: 'activation-only',
            ...(input.outputContract ? { outputContract: input.outputContract } : {}),
            ...(input.requestedTurnId ? { requestedTurnId: input.requestedTurnId } : {}),
            ...(input.clientIntent ? { clientIntent: input.clientIntent } : {}),
            ...(input.resumePausedQueue ? { resumePausedQueue: true } : {}),
            delivery: {
                ...directSendDisplayOptions(input),
                beforeStart: async () => {
                    await retryOnce(() => this.options.activation.prepareForUserActivation(input.sessionId));
                },
            },
            preDelivery: {
                accept: async ({ mode, turnId }) => {
                    reservation.bindTurn(turnId);
                    if (mode === 'activated' && workspaceGate) {
                        try {
                            await workspaceGate.prepareForSessionStart(input.sessionId);
                        }
                        catch (cause) {
                            throw new WorkspaceInitialSnapshotGateError({ cause });
                        }
                    }
                },
            },
        });
        if (!result.delivered) {
            reservation.discardIfEmpty();
            return { accepted: false, reason: result.reason };
        }
        if (result.mode === 'duplicate') {
            reservation.discardIfEmpty();
            return { accepted: false, reason: 'duplicate', turnId: result.turnId };
        }
        if (result.mode === 'activated') {
            observeCompletion(result.completion, reservation.complete);
            return {
                accepted: true,
                turnId: result.turnId,
                completion: result.completion,
                frames: reservation.source,
            };
        }
        return {
            accepted: true,
            turnId: result.turnId,
            frames: completeOnTurnTerminal(reservation),
        };
    }
    async openPausedQueueSend(input, reservation) {
        const workspaceGate = this.options.workspaceGate;
        const idempotencyKey = input.requestedTurnId ?? `paused-queue-send:${randomUUID()}`;
        const observedPause = await readQueuePause(this.options.queue, input.sessionId);
        const result = await this.options.turns.steer({
            sessionId: input.sessionId,
            input: input.input,
            provenance: input.provenance,
            producerId: 'paused-queue-composer',
            idempotencyKey,
            modelSelectionScope: 'activation-only',
            ...(input.outputContract ? { outputContract: input.outputContract } : {}),
            ...(input.requestedTurnId ? { requestedTurnId: input.requestedTurnId } : {}),
            ...(input.clientIntent ? { clientIntent: input.clientIntent } : {}),
            ...(input.resumePausedQueue ? { resumePausedQueue: true } : {}),
            delivery: {
                ...directSendDisplayOptions(input),
                beforeStart: async () => {
                    await retryOnce(() => this.options.activation.prepareForUserActivation(input.sessionId));
                },
            },
            preDelivery: {
                accept: async ({ mode, turnId }) => {
                    reservation.bindTurn(turnId);
                    if (mode === 'activated' && workspaceGate) {
                        try {
                            await workspaceGate.prepareForSessionStart(input.sessionId);
                        }
                        catch (cause) {
                            throw new WorkspaceInitialSnapshotGateError({ cause });
                        }
                    }
                },
            },
        });
        return this.handlePausedQueueSendResult(input, reservation, result, observedPause);
    }
    async handlePausedQueueSendResult(input, reservation, result, observedPause) {
        const cleanupKey = input.requestedTurnId
            ? `${input.sessionId}\u0000${input.requestedTurnId}`
            : undefined;
        if (!result.delivered) {
            reservation.discardIfEmpty();
            return { accepted: false, reason: result.reason };
        }
        if (result.mode === 'duplicate') {
            await this.retryPendingQueuePauseCleanup(input.sessionId, cleanupKey);
            reservation.discardIfEmpty();
            return { accepted: false, reason: 'duplicate', turnId: result.turnId };
        }
        if (result.mode === 'activated') {
            observeCompletion(result.completion, reservation.complete);
            return {
                accepted: true,
                turnId: result.turnId,
                completion: result.completion,
                frames: reservation.source,
            };
        }
        if (cleanupKey && observedPause) {
            this.pendingQueuePauseCleanups.set(cleanupKey, observedPause);
        }
        const cleaned = await continueQueueAfterDeliveredSteer(this.options.queue, input.sessionId, observedPause);
        if (cleanupKey && observedPause && cleaned) {
            this.pendingQueuePauseCleanups.delete(cleanupKey);
        }
        return {
            accepted: true,
            turnId: result.turnId,
            frames: completeOnTurnTerminal(reservation),
        };
    }
    async retryPendingQueuePauseCleanup(sessionId, cleanupKey) {
        if (!cleanupKey)
            return;
        const pendingCleanup = this.pendingQueuePauseCleanups.get(cleanupKey);
        if (!pendingCleanup)
            return;
        if (await continueQueueAfterDeliveredSteer(this.options.queue, sessionId, pendingCleanup)) {
            this.pendingQueuePauseCleanups.delete(cleanupKey);
        }
    }
}
async function continueQueueAfterDeliveredSteer(queue, sessionId, expectedPause) {
    if (!expectedPause)
        return true;
    try {
        await queue.continueQueue(sessionId, expectedPause);
        return true;
    }
    catch {
        // The message already reached the active Turn; cleanup cannot roll delivery back.
        return false;
    }
}
async function readQueuePause(queue, sessionId) {
    try {
        return (await queue.snapshot(sessionId)).pause;
    }
    catch {
        // Delivery stays available when Queue cleanup state cannot be read safely.
        return undefined;
    }
}
async function classifyQueuePauseBlock(queue, sessionId, result) {
    if (result.reason !== 'priority-blocked')
        return result;
    return (await readQueuePause(queue, sessionId))
        ? { accepted: false, reason: 'queue-paused' }
        : result;
}
function isPausedQueueSend(input) {
    return (input.resumePausedQueue === true ||
        input.clientIntent === 'paused-queue-keep' ||
        input.clientIntent === 'paused-queue-clear');
}
function isComposerSteerSend(clientIntent) {
    return clientIntent === 'composer-steer';
}
function completeOnTurnTerminal(reservation) {
    const source = reservation.source;
    let closed = false;
    const done = () => ({ done: true, value: undefined });
    const iterator = {
        [Symbol.asyncIterator]() {
            return iterator;
        },
        async next() {
            if (closed)
                return done();
            const result = await source.next();
            if (result.done) {
                closed = true;
                return result;
            }
            if (result.value.kind === 'turn-terminal') {
                closed = true;
                reservation.complete();
            }
            return result;
        },
        async return() {
            if (!closed) {
                closed = true;
                reservation.close();
            }
            return done();
        },
    };
    return iterator;
}
async function retryOnce(operation) {
    try {
        return await operation();
    }
    catch {
        return operation();
    }
}
function observeCompletion(completion, complete) {
    directSendObservations.add(completeAfterSettlement(completion, complete));
}
async function completeAfterSettlement(completion, complete) {
    try {
        await completion;
    }
    finally {
        complete();
    }
}
function directSendDisplayOptions(input) {
    return {
        ...(input.displayContent !== undefined ? { displayContent: input.displayContent } : {}),
        ...(input.displayAttachments
            ? { displayAttachments: input.displayAttachments.map((attachment) => ({ ...attachment })) }
            : {}),
        ...(input.hideUserMessage ? { hideUserMessage: true } : {}),
    };
}
//# sourceMappingURL=direct-send-delivery.js.map