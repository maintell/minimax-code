import { isHandedBackOnClose, isUserSteeringProducer, } from '../../agent-host/runner/contracts.js';
export function createInMemoryTurnControl(options = {}) {
    const entries = new Map();
    let sequence = 0;
    const handBack = (entry, messages, cause, workClosed) => {
        if (messages.length === 0)
            return;
        try {
            options.onHandBack?.({
                sessionId: entry.lease.sessionId,
                turnId: entry.lease.turnId,
                messages: [...messages],
                cause,
                ...(workClosed ? { workClosed: true } : {}),
            });
        }
        catch {
            // The hand-off never breaks Turn teardown.
        }
    };
    const live = (entry) => entries.get(entry.lease.sessionId) === entry ? entry : undefined;
    return {
        accept: ({ sessionId, turnId }) => {
            if (entries.has(sessionId))
                throw new Error(`Turn already active: ${sessionId}`);
            sequence += 1;
            const abortController = new AbortController();
            const lease = {
                sessionId,
                turnId,
                leaseId: `in-memory-lease-${String(sequence)}`,
                busyReason: 'turn',
                acceptedSequence: sequence,
                acceptedAtMs: sequence,
                signal: abortController.signal,
            };
            const entry = newEntry(lease, abortController);
            entries.set(sessionId, entry);
            return { lease, control: bindControl(entry, live, handBack) };
        },
        steer: (input) => steer(entries.get(input.sessionId), input),
        abort: ({ sessionId, reason }) => {
            const entry = entries.get(sessionId);
            if (!entry)
                return false;
            if (entry.phase === 'closing') {
                entry.closeAbortRequested = true;
                return true;
            }
            if (!entry.abortController.signal.aborted)
                abortEntry(entry, reason, handBack);
            return true;
        },
        complete: (lease) => {
            const entry = entries.get(lease.sessionId);
            if (entry?.lease !== lease)
                return;
            entries.delete(lease.sessionId);
            clearControl(entry);
        },
    };
}
function newEntry(lease, abortController) {
    return {
        lease,
        abortController,
        steering: [],
        identities: new Set(),
        claims: new Set(),
        tail: [],
        tailClaims: new Map(),
        tailOpen: 0,
        wake: new AbortController(),
        phase: 'running',
    };
}
function bindControl(entry, live, handBack) {
    return {
        steeringSignal: () => live(entry)?.wake.signal,
        drainSteering: async () => drainSteering(live(entry)),
        ackSteering: async (messages) => {
            const current = live(entry);
            messages.forEach((message) => current?.claims.delete(steeringIdentity(message)));
        },
        restoreSteering: async (messages) => restoreSteering(live(entry), messages, handBack),
        tryBeginClose: async (closeOptions) => tryBeginClose(live(entry), handBack, closeOptions),
        cancelClose: async () => cancelClose(live(entry)),
        sealAbnormalTerminal: async () => sealAbnormalTerminal(live(entry), entry.lease, handBack),
        toolResultTail: {
            open: async () => openToolResultTail(live(entry)),
            closeAndClaim: async (toolCallId) => closeAndClaimToolResultTail(live(entry), toolCallId),
            ack: async (toolCallId) => {
                live(entry)?.tailClaims.delete(toolCallId);
            },
        },
    };
}
function steer(entry, input) {
    const lane = input.lane ?? 'ordinary';
    if (!entry)
        return 'not-running';
    if (entry.lease.turnId !== input.turnId)
        return 'turn-mismatch';
    if (isClosedToSteer(entry, input.message, lane))
        return 'closing';
    if (lane === 'tool-result-tail' && entry.tailOpen === 0)
        return 'delivery-closed';
    const identity = steeringIdentity(input.message);
    if (entry.identities.has(identity))
        return 'accepted';
    (lane === 'ordinary' ? entry.steering : entry.tail).push(input.message);
    entry.identities.add(identity);
    if (lane === 'ordinary') {
        const wake = entry.wake;
        entry.wake = new AbortController();
        wake.abort();
    }
    return 'accepted';
}
/**
 * A closing Turn takes no steering. After a reopen, user steering still waits:
 * the won close already handed earlier user input back, and newer input must
 * not overtake it. Machine delivery joins the continuation.
 */
function isClosedToSteer(entry, message, lane) {
    if (entry.phase !== 'running')
        return true;
    return (lane === 'ordinary' &&
        entry.reopenedAfterClose === true &&
        isUserSteeringProducer(message.producerId));
}
function drainSteering(entry) {
    if (!entry || entry.phase === 'aborted')
        return [];
    const claimed = entry.steering.splice(0);
    claimed.forEach((message) => entry.claims.add(steeringIdentity(message)));
    return claimed;
}
function restoreSteering(entry, messages, handBack) {
    if (!entry)
        return;
    const restored = messages.filter((message) => entry.claims.delete(steeringIdentity(message)));
    if (entry.phase === 'aborted') {
        handBack(entry, restored, 'abort');
        return;
    }
    entry.steering.unshift(...restored);
}
function tryBeginClose(entry, handBack, options) {
    if (!entry)
        return { closed: false, reason: 'stale-lease' };
    if (entry.phase === 'aborted') {
        return {
            closed: false,
            reason: 'aborted',
            ...(entry.abortReason ? { abortReason: entry.abortReason } : {}),
        };
    }
    const workClosed = options?.workClosed === true;
    // A final close follows the runner's last poll: nothing is left to consume pending input.
    if (options?.final !== true && holdsClose(entry, workClosed)) {
        return { closed: false, reason: 'steer-pending' };
    }
    handBack(entry, entry.steering.splice(0), 'exit-close', workClosed);
    entry.phase = 'closing';
    return { closed: true };
}
/**
 * In-flight consumption, and machine steering that has no requeue lane, keep
 * the Turn polling. User steering never extends a finished answer.
 */
function holdsClose(entry, workClosed) {
    return (entry.claims.size > 0 ||
        entry.tail.length > 0 ||
        entry.tailClaims.size > 0 ||
        entry.steering.some((message) => !isHandedBackOnClose(message.producerId, workClosed)));
}
function cancelClose(entry) {
    if (!entry || entry.phase !== 'closing' || entry.closeAbortRequested)
        return false;
    if (entry.abortController.signal.aborted)
        return false;
    entry.phase = 'running';
    entry.reopenedAfterClose = true;
    return true;
}
function sealAbnormalTerminal(entry, lease, handBack) {
    if (!entry)
        throw new Error(`Stale Turn lease: ${lease.sessionId}/${lease.turnId}`);
    handBack(entry, entry.steering.slice(), 'abnormal-seal');
    clearControl(entry);
    if (entry.phase !== 'aborted')
        entry.phase = 'closing';
}
function openToolResultTail(entry) {
    if (!entry || entry.phase !== 'running')
        return false;
    entry.tailOpen += 1;
    return true;
}
function closeAndClaimToolResultTail(entry, toolCallId) {
    if (!entry || entry.phase === 'aborted')
        return [];
    entry.tailOpen = Math.max(0, entry.tailOpen - 1);
    const replay = entry.tailClaims.get(toolCallId);
    if (replay)
        return replay;
    const claimed = entry.tail.splice(0);
    if (claimed.length > 0)
        entry.tailClaims.set(toolCallId, claimed);
    return claimed;
}
function abortEntry(entry, reason, handBack) {
    entry.phase = 'aborted';
    entry.abortReason = reason;
    handBack(entry, entry.steering.slice(), 'abort');
    // Drained claims stay restorable, so a failed consumption still reaches the Host.
    clearControl(entry, true);
    entry.abortController.abort(reason);
}
function clearControl(entry, preserveClaims = false) {
    entry.steering.splice(0);
    if (!preserveClaims)
        entry.claims.clear();
    entry.tail.splice(0);
    entry.tailClaims.clear();
    entry.tailOpen = 0;
}
function steeringIdentity(message) {
    return `${message.producerId}\u0000${message.idempotencyKey}`;
}
//# sourceMappingURL=turn-control.js.map