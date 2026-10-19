/** Bridges durable Queue acceptance to the existing per-Turn completion handle. */
export function createQueuedTurnCompletionRegistry() {
    const byTurn = new Map();
    const byItem = new Map();
    const observations = new WeakSet();
    return {
        register: (turnId, sessionId) => {
            const entry = entryFor(byTurn, turnId);
            if (entry.sessionId === undefined)
                entry.sessionId = sessionId;
            return entry.promise;
        },
        requestCancellation: (sessionId, turnId, reason) => {
            const entry = byTurn.get(turnId);
            if (!entry || entry.sessionId !== sessionId || entry.phase !== 'pending')
                return false;
            entry.cancellationReason ??= reason;
            return true;
        },
        isPending: (sessionId, turnId) => {
            const entry = byTurn.get(turnId);
            return entry?.sessionId === sessionId && entry.phase === 'pending';
        },
        prepareExecution: (claim, turnId) => {
            const entry = byItem.get(claim.item.itemId);
            if (!entry || entry.sessionId !== claim.sessionId || entry.phase !== 'pending')
                return;
            if (entry.executionTurnId && entry.executionTurnId !== entry.turnId)
                byTurn.delete(entry.executionTurnId);
            entry.executionTurnId = turnId;
            byTurn.set(turnId, entry);
        },
        executionTurnId: (sessionId, turnId) => {
            const entry = byTurn.get(turnId);
            return entry?.sessionId === sessionId ? entry.executionTurnId : undefined;
        },
        beginExecution: (sessionId, turnId) => {
            const entry = byTurn.get(turnId);
            if (!entry || entry.sessionId !== sessionId || entry.phase !== 'pending')
                return undefined;
            const reason = entry.cancellationReason;
            entry.phase = 'executing';
            delete entry.cancellationReason;
            return reason;
        },
        beginSettlement: (sessionId, turnId) => {
            const entry = byTurn.get(turnId);
            if (!entry || entry.sessionId !== sessionId)
                return;
            entry.phase = 'settling';
            delete entry.cancellationReason;
        },
        cancellationReason: (sessionId, turnId) => {
            const entry = byTurn.get(turnId);
            return entry?.sessionId === sessionId && entry.phase === 'pending'
                ? entry.cancellationReason
                : undefined;
        },
        bind: (turnId, itemId) => {
            const entry = entryFor(byTurn, turnId);
            entry.itemIds.add(itemId);
            byItem.set(itemId, entry);
        },
        discard: (turnId) => settle(byTurn, byItem, turnId, failed('Queue submission was discarded')),
        observe: (claim, result) => {
            const turnId = claim.item.requestedTurnId ?? ('turnId' in result ? result.turnId : undefined);
            if (!turnId)
                return;
            const entry = byTurn.get(turnId);
            if (!entry || entry.observing)
                return;
            if (result.accepted) {
                if (entry.phase === 'pending')
                    entry.phase = 'executing';
                entry.observing = true;
                observations.add(settleFromCompletion(byTurn, byItem, entry, result.completion));
                return;
            }
            if (result.reason === 'duplicate') {
                settle(byTurn, byItem, turnId, failed(`Queued Turn completion is unavailable for duplicate ${result.turnId}`));
            }
        },
        handleFacts: (facts) => {
            for (const fact of facts) {
                if (fact.kind !== 'removed')
                    continue;
                const entry = byItem.get(fact.itemId);
                if (!entry)
                    continue;
                byItem.delete(fact.itemId);
                entry.itemIds.delete(fact.itemId);
                if (fact.reason === 'accepted')
                    continue;
                if (fact.reason === 'injected') {
                    // A steered item joins someone else's running Turn; admission is the
                    // only durable outcome its waiter can observe (mirrors steer ACK).
                    settle(byTurn, byItem, entry.turnId, { status: 'completed' });
                    continue;
                }
                settle(byTurn, byItem, entry.turnId, fact.reason === 'cancelled' || fact.reason === 'composer-transferred'
                    ? { status: 'aborted', reason: `queue-${fact.reason}` }
                    : failed(`Queue item was removed before Turn activation: ${fact.reason}`));
            }
        },
        close: () => {
            for (const turnId of [...byTurn.keys()]) {
                settle(byTurn, byItem, turnId, {
                    status: 'aborted',
                    reason: 'runtime-shutdown',
                });
            }
        },
    };
}
function entryFor(byTurn, turnId) {
    const existing = byTurn.get(turnId);
    if (existing)
        return existing;
    let resolve = (_outcome) => undefined;
    const promise = new Promise((settlePromise) => {
        resolve = settlePromise;
    });
    const entry = {
        turnId,
        promise,
        resolve,
        itemIds: new Set(),
        observing: false,
        phase: 'pending',
    };
    byTurn.set(turnId, entry);
    return entry;
}
async function settleFromCompletion(byTurn, byItem, entry, completion) {
    try {
        settle(byTurn, byItem, entry.turnId, await completion);
    }
    catch (error) {
        settle(byTurn, byItem, entry.turnId, failed(error));
    }
}
function settle(byTurn, byItem, turnId, outcome) {
    const entry = byTurn.get(turnId);
    if (!entry)
        return;
    byTurn.delete(entry.turnId);
    if (entry.executionTurnId)
        byTurn.delete(entry.executionTurnId);
    for (const itemId of entry.itemIds)
        byItem.delete(itemId);
    entry.itemIds.clear();
    entry.resolve(outcome);
}
function failed(error) {
    return { status: 'failed', error: error instanceof Error ? error : new Error(String(error)) };
}
//# sourceMappingURL=queued-turn-completion.js.map