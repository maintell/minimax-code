export function resetAdmission(input, turnId, candidateCreatedAtMs) {
    return {
        sessionId: input.sessionId,
        turnId,
        busyReason: 'compaction',
        inputDigest: `bunny-context-reset:${turnId}`,
        inputMetadata: { attachmentCount: 0, hasContent: false },
        candidateCreatedAtMs,
        priority: { kind: 'fifo', candidateCreatedAtMs },
        // The reset goes ahead of queued messages and leaves the queue unpaused (3.3).
        bypassPriorityFence: true,
        consumeQueuePause: true,
    };
}
export function retriesAdmission(admitted) {
    return (admitted.status !== 'duplicate' &&
        (admitted.reason === 'active-turn' || admitted.reason === 'compaction-active'));
}
export function rejection(admitted) {
    if (admitted.status === 'duplicate') {
        return { accepted: false, reason: 'duplicate', turnId: admitted.turnId };
    }
    return { accepted: false, reason: admitted.reason };
}
export async function waitAtMost(promise, timeoutMs) {
    let timer;
    try {
        await Promise.race([
            settledQuietly(promise),
            new Promise((resolve) => {
                timer = setTimeout(resolve, timeoutMs);
            }),
        ]);
    }
    finally {
        clearTimeout(timer);
    }
}
async function settledQuietly(promise) {
    try {
        await promise;
    }
    catch {
        // Only the moment it settles matters.
    }
}
//# sourceMappingURL=admission.js.map