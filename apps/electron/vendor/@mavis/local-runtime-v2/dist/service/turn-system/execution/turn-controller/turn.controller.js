import { waitForRelease } from './wait-for-release.js';
import { isUserSteeringProducer } from '../../agent-host/contracts.js';
const DEFAULT_ABORT_TIMEOUT_MS = 5_000;
const DEFAULT_RENEWAL_INTERVAL_MS = 10_000;
export function createTurnController(options) {
    const entries = new Map();
    const abortTimeoutMs = positiveInteger(options.abortTimeoutMs, DEFAULT_ABORT_TIMEOUT_MS);
    const renewalIntervalMs = positiveInteger(options.renewalIntervalMs, DEFAULT_RENEWAL_INTERVAL_MS);
    let closed = false;
    let draining = false;
    let pendingAdmissionCount = 0;
    let idleDrain;
    const resolveIdleDrain = () => {
        if (entries.size === 0 && pendingAdmissionCount === 0)
            idleDrain?.resolve();
    };
    const beginDrain = () => {
        draining = true;
        idleDrain ??= deferred();
        resolveIdleDrain();
        return {
            activeTurnCount: entries.size,
            pendingAdmissionCount,
            idle: idleDrain.promise,
        };
    };
    let closePromise;
    const discardSteering = (entry, messages, cause) => {
        if (messages.length === 0)
            return;
        try {
            options.onSteeringDiscarded?.({
                sessionId: entry.turn.sessionId,
                turnId: entry.turn.turnId,
                messages,
                cause,
                ...(entry.abortReason ? { abortReason: entry.abortReason } : {}),
                turnReleased: entry.released,
            });
        }
        catch {
            // The steering hand-off must never break Turn teardown.
        }
    };
    function register(input) {
        if (closed)
            throw new Error('Turn controller is shutting down');
        if (entries.has(input.sessionId))
            throw new Error(`Turn already active: ${input.sessionId}`);
        const abortController = new AbortController();
        const turn = { ...input, signal: abortController.signal };
        const released = deferred();
        const entry = {
            turn,
            abortController,
            released: released.promise,
            resolveReleased: released.resolve,
            steering: [],
            steeringWake: new AbortController(),
            steeringIdentities: new Set(),
            steeringClaims: new Set(),
            toolResultTail: [],
            toolResultTailClaims: new Map(),
            toolResultTailOpen: 0,
            phase: 'running',
            releaseListeners: [],
            renewalTimer: setInterval(() => scheduleRenewal(entry), renewalIntervalMs),
        };
        entry.renewalTimer.unref?.();
        entries.set(input.sessionId, entry);
        const cancellationReason = options.onRegister?.(input.sessionId, input.turnId);
        if (cancellationReason !== undefined)
            abortEntry(entry, cancellationReason, discardSteering);
        return turn;
    }
    async function renew(entry) {
        try {
            const renewed = await options.renew({
                sessionId: entry.turn.sessionId,
                leaseId: entry.turn.leaseId,
            });
            if (entries.get(entry.turn.sessionId) !== entry || entry.phase !== 'running')
                return;
            if (!renewed)
                abortEntry(entry, 'lease-lost', discardSteering);
        }
        catch {
            if (entries.get(entry.turn.sessionId) === entry && entry.phase === 'running') {
                abortEntry(entry, 'lease-renewal-failed', discardSteering);
            }
        }
        finally {
            entry.renewalTask = undefined;
        }
    }
    function scheduleRenewal(entry) {
        if (entry.renewalTask || entry.phase !== 'running')
            return;
        entry.renewalTask = renew(entry);
    }
    function scope(lease) {
        return {
            setComputerUseAvailable: (available) => {
                const entry = matchingEntry(entries, lease);
                if (entry?.phase === 'running')
                    entry.computerUseAvailable ??= available;
            },
            drainSteering: () => drainSteering(entries, lease),
            steeringSignal: () => matchingEntry(entries, lease)?.steeringWake.signal,
            ackSteering: (messages) => ackSteering(entries, lease, messages),
            restoreSteering: (messages) => restoreSteering(entries, lease, messages, discardSteering),
            tryBeginClose: () => tryBeginClose(entries, lease, discardSteering),
            sealAbnormalTerminal: () => sealAbnormalTerminal(entries, lease, discardSteering),
            openToolResultTail: () => openToolResultTail(entries, lease),
            closeAndClaimToolResultTail: (toolCallId) => closeAndClaimToolResultTail(entries, lease, toolCallId),
            ackToolResultTail: (toolCallId) => ackToolResultTail(entries, lease, toolCallId),
        };
    }
    return {
        tryEnterAdmission: () => {
            if (closed || draining)
                return undefined;
            pendingAdmissionCount += 1;
            let released = false;
            return {
                release: () => {
                    if (released)
                        return;
                    released = true;
                    pendingAdmissionCount -= 1;
                    resolveIdleDrain();
                },
            };
        },
        beginDrain,
        tryBeginDrainIfIdle: () => {
            if (entries.size > 0 || pendingAdmissionCount > 0) {
                return { acquired: false, activeTurnCount: entries.size, pendingAdmissionCount };
            }
            return { acquired: true, drain: beginDrain() };
        },
        register,
        scope,
        abort: async ({ sessionId, turnId, reason, onAccepted, onReleased }) => {
            const entry = entries.get(sessionId);
            if (!entry)
                return { status: 'not-running' };
            if (turnId && entry.turn.turnId !== turnId)
                return { status: 'turn-mismatch' };
            // Attached before `onAccepted` can yield: the Turn may release while that
            // hook is still running, and the release moment must not be missed.
            watchRelease(entry, onReleased);
            if (entry.phase === 'closing') {
                await onAccepted?.();
                const released = await waitForRelease(entry.released, abortTimeoutMs);
                return released
                    ? { status: 'released', turnId: entry.turn.turnId }
                    : { status: 'abort-timeout', turnId: entry.turn.turnId };
            }
            if (!entry.turn.signal.aborted)
                abortEntry(entry, reason, discardSteering);
            await onAccepted?.();
            const released = await waitForRelease(entry.released, abortTimeoutMs);
            return released
                ? { status: 'aborted', turnId: entry.turn.turnId }
                : { status: 'abort-timeout', turnId: entry.turn.turnId };
        },
        steerActiveTurn: (input) => steer(entries, input, 'ordinary'),
        steerToolResultTail: (input) => steer(entries, input, 'tool-result-tail'),
        hasPendingUserSteering: (sessionId) => {
            const entry = entries.get(sessionId);
            if (!entry)
                return false;
            return entry.steering.some((message) => isUserSteeringProducer(message.producerId));
        },
        beginClose: (lease) => tryBeginClose(entries, lease, discardSteering),
        complete: (turn) => {
            const entry = matchingEntry(entries, turn);
            if (!entry)
                return;
            clearInterval(entry.renewalTimer);
            entries.delete(turn.sessionId);
            clearControl(entry);
            // Synchronously, right after `entries.delete`: nothing can register the
            // next Turn in between, so a listener sees the exact release moment.
            notifyReleased(options, entry);
            entry.resolveReleased();
            resolveIdleDrain();
        },
        activeTurnId: (sessionId) => entries.get(sessionId)?.turn.turnId,
        close: () => {
            if (closePromise)
                return closePromise;
            closed = true;
            const active = [...entries.values()];
            const shutdownAborts = active.filter((entry) => !entry.turn.signal.aborted);
            logRuntimeShutdown(options, active, shutdownAborts);
            for (const entry of shutdownAborts) {
                abortEntry(entry, 'runtime-shutdown', discardSteering);
            }
            closePromise = drainActiveTurns(active, abortTimeoutMs);
            return closePromise;
        },
    };
}
function logRuntimeShutdown(options, active, shutdownAborts) {
    try {
        const shutdownAbortEntries = new Set(shutdownAborts);
        options.logger?.info({
            reason: 'runtime-shutdown',
            active_turn_count: active.length,
            shutdown_abort_count: shutdownAborts.length,
            active_turns: active.map((entry) => ({
                session_id: entry.turn.sessionId,
                turn_id: entry.turn.turnId,
                busy_reason: entry.turn.busyReason,
                phase: entry.phase,
                ...(entry.abortReason ? { abort_reason: entry.abortReason } : {}),
                shutdown_abort: shutdownAbortEntries.has(entry),
            })),
        }, '[local-runtime-v2] Turn controller shutdown');
    }
    catch {
        // Diagnostics must never change shutdown behavior.
    }
}
function watchRelease(entry, listener) {
    if (listener)
        entry.releaseListeners.push(listener);
}
/**
 * Runs each accepted abort's `onReleased` exactly once. A failing listener is
 * logged and never reaches the caller settling the Turn: releasing ownership
 * must not depend on a stop's follow-up, nor may one listener starve the next.
 */
function notifyReleased(options, entry) {
    for (const listener of entry.releaseListeners.splice(0)) {
        try {
            listener();
        }
        catch (error) {
            logReleaseListenerFailure(options, entry, error);
        }
    }
}
function logReleaseListenerFailure(options, entry, error) {
    try {
        options.logger?.info({
            event: 'turn_release_listener_failed',
            session_id: entry.turn.sessionId,
            turn_id: entry.turn.turnId,
            error: error instanceof Error ? error.message : String(error),
        }, '[local-runtime-v2] Turn release listener failed');
    }
    catch {
        // Diagnostics must never change release behavior.
    }
}
async function drainActiveTurns(entries, timeoutMs) {
    const drained = await Promise.all(entries.map((entry) => waitForRelease(entryDrain(entry), timeoutMs)));
    const timedOut = entries.filter((_entry, index) => !drained[index]);
    if (timedOut.length === 0)
        return;
    throw new Error(`Turn controller shutdown timed out: ${timedOut.map(({ turn }) => turn.turnId).join(',')}`);
}
async function entryDrain(entry) {
    await Promise.all([entry.released, entry.renewalTask ?? Promise.resolve()]);
}
function steer(entries, input, lane) {
    const entry = entries.get(input.sessionId);
    if (!entry)
        return Promise.resolve({ status: 'not-running' });
    if (entry.turn.turnId !== input.turnId) {
        return Promise.resolve({ status: 'turn-mismatch' });
    }
    if (entry.turn.busyReason !== 'turn') {
        return Promise.resolve({ status: 'unsupported-delivery' });
    }
    if (entry.phase !== 'running')
        return Promise.resolve({ status: 'closing' });
    if (lane === 'tool-result-tail' && entry.toolResultTailOpen === 0) {
        return Promise.resolve({ status: 'delivery-closed' });
    }
    const identity = steeringIdentity(input.message);
    if (entry.steeringIdentities.has(identity)) {
        promoteForegroundSteer(entry.turn, lane, input.foreground);
        return Promise.resolve({ status: 'accepted', turnId: input.turnId });
    }
    // A first Computer Use request cannot join a catalog frozen without the native tools.
    // Unknown means preparation is still running; leave it queued rather than race the snapshot.
    if (requiresComputerUseTurn(entry, input.message, lane)) {
        return Promise.resolve({ status: 'computer-use-requires-new-turn' });
    }
    promoteForegroundSteer(entry.turn, lane, input.foreground);
    const target = lane === 'ordinary' ? entry.steering : entry.toolResultTail;
    target.push(input.message);
    entry.steeringIdentities.add(identity);
    wakeOrdinarySteering(entry, lane);
    return Promise.resolve({ status: 'accepted', turnId: input.turnId });
}
function requiresComputerUseTurn(entry, message, lane) {
    if (lane !== 'ordinary' || entry.computerUseAvailable === true)
        return false;
    return (message.message.computerUse?.enable === true ||
        message.batchMembers?.some((member) => member.message.computerUse?.enable === true) === true);
}
function promoteForegroundSteer(turn, lane, foreground) {
    if (lane === 'ordinary' && foreground)
        turn.foreground = true;
}
function wakeOrdinarySteering(entry, lane) {
    if (lane !== 'ordinary')
        return;
    const wake = entry.steeringWake;
    entry.steeringWake = new AbortController();
    wake.abort();
}
function drainSteering(entries, lease) {
    const entry = matchingEntry(entries, lease);
    if (!entry || entry.phase === 'aborted')
        return [];
    const claimed = entry.steering.splice(0);
    claimed.forEach((message) => entry.steeringClaims.add(steeringIdentity(message)));
    return claimed;
}
function ackSteering(entries, lease, messages) {
    const entry = matchingEntry(entries, lease);
    messages.forEach((message) => entry?.steeringClaims.delete(steeringIdentity(message)));
}
function restoreSteering(entries, lease, messages, onDiscarded) {
    const entry = matchingEntry(entries, lease);
    if (!entry)
        return;
    const restored = messages.filter((message) => {
        const identity = steeringIdentity(message);
        if (!entry.steeringClaims.has(identity))
            return false;
        entry.steeringClaims.delete(identity);
        return true;
    });
    if (entry.phase === 'aborted') {
        onDiscarded(entry, restored, 'abort');
        return;
    }
    entry.steering.unshift(...restored);
}
function openToolResultTail(entries, lease) {
    const entry = matchingEntry(entries, lease);
    if (!entry || entry.phase !== 'running')
        return false;
    entry.toolResultTailOpen += 1;
    return true;
}
function closeAndClaimToolResultTail(entries, lease, toolCallId) {
    const entry = matchingEntry(entries, lease);
    if (!entry || entry.phase === 'aborted')
        return [];
    entry.toolResultTailOpen = Math.max(0, entry.toolResultTailOpen - 1);
    const replay = entry.toolResultTailClaims.get(toolCallId);
    if (replay)
        return replay;
    const claimed = entry.toolResultTail.splice(0);
    if (claimed.length > 0)
        entry.toolResultTailClaims.set(toolCallId, claimed);
    return claimed;
}
function ackToolResultTail(entries, lease, toolCallId) {
    matchingEntry(entries, lease)?.toolResultTailClaims.delete(toolCallId);
}
function tryBeginClose(entries, lease, onDiscarded) {
    const entry = matchingEntry(entries, lease);
    if (!entry)
        return { closed: false, reason: 'stale-lease' };
    if (entry.phase === 'aborted') {
        return {
            closed: false,
            reason: 'aborted',
            ...(entry.abortReason ? { abortReason: entry.abortReason } : {}),
        };
    }
    if (hasInFlightConsumption(entry))
        return { closed: false, reason: 'steer-pending' };
    // Acknowledged non-user steering (cron, communication, task appends) has no
    // requeue lane: hold the close so the runner polls again and consumes it,
    // matching the pre-exit-boundary contract. Losing delivered machine input
    // outweighs finishing the answer one step earlier.
    if (entry.steering.some((message) => !isUserSteeringProducer(message.producerId))) {
        return { closed: false, reason: 'steer-pending' };
    }
    // Exit-boundary rule: user steering that was not consumed by the final step
    // never extends the finished answer. The batch goes to the discard callback
    // (user producers are requeued as plain queries) and the close proceeds.
    if (entry.steering.length > 0)
        onDiscarded(entry, entry.steering.splice(0), 'exit-close');
    entry.phase = 'closing';
    return { closed: true };
}
function sealAbnormalTerminal(entries, lease, onDiscarded) {
    const entry = matchingEntry(entries, lease);
    if (!entry) {
        return Promise.reject(new Error(`Stale Turn lease: ${lease.sessionId}/${lease.turnId}`));
    }
    onDiscarded(entry, entry.steering.slice(), 'abnormal-seal');
    clearControl(entry);
    if (entry.phase !== 'aborted')
        entry.phase = 'closing';
    return Promise.resolve();
}
function matchingEntry(entries, turn) {
    const entry = entries.get(turn.sessionId);
    if (!entry)
        return undefined;
    const accepted = entry.turn;
    return accepted.turnId === turn.turnId &&
        accepted.leaseId === turn.leaseId &&
        accepted.acceptedSequence === turn.acceptedSequence &&
        accepted.busyReason === turn.busyReason &&
        accepted.signal === turn.signal
        ? entry
        : undefined;
}
function abortEntry(entry, reason, onDiscarded) {
    clearInterval(entry.renewalTimer);
    entry.phase = 'aborted';
    entry.abortReason = reason;
    onDiscarded(entry, entry.steering.slice(), 'abort');
    clearControl(entry, true);
    entry.abortController.abort(reason);
}
function clearControl(entry, preserveSteeringClaims = false) {
    entry.steering.splice(0);
    if (!preserveSteeringClaims)
        entry.steeringClaims.clear();
    entry.toolResultTail.splice(0);
    entry.toolResultTailClaims.clear();
    entry.toolResultTailOpen = 0;
}
/** Drained or claimed steering whose consumption is still committing. */
function hasInFlightConsumption(entry) {
    return (entry.steeringClaims.size > 0 ||
        entry.toolResultTail.length > 0 ||
        entry.toolResultTailClaims.size > 0);
}
function steeringIdentity(message) {
    return `${message.producerId}\u0000${message.idempotencyKey}`;
}
function deferred() {
    let resolvePromise;
    const promise = new Promise((resolve) => {
        resolvePromise = resolve;
    });
    return { promise, resolve: () => resolvePromise?.() };
}
function positiveInteger(value, fallback) {
    return Math.max(1, Math.floor(value ?? fallback));
}
//# sourceMappingURL=turn.controller.js.map