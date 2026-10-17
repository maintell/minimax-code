/** Session-owned dispatch facade; Turn never receives the Queue repository. */
export function createQueueDispatchCapability(options) {
    return {
        listPendingSessionIds: () => options.repository.listPendingSessionIds(),
        claimNext: async ({ sessionId, itemId, continuePaused, excludeItemIds }) => {
            const result = await options.repository.claimNext({
                sessionId,
                ...(itemId ? { itemId } : {}),
                ...(continuePaused ? { continuePaused } : {}),
                ...(excludeItemIds?.length ? { excludeItemIds } : {}),
            });
            options.facts.handle(result.facts);
            return result.value ? toDispatchClaim(result.value) : undefined;
        },
        prepareDelivery: (input) => options.repository.prepareDelivery(input),
        acknowledge: async ({ sessionId, claimId, turnId }) => {
            const result = await options.repository.acknowledgeClaim(sessionId, claimId, turnId, options.acceptance);
            options.facts.handle(result.facts);
        },
        release: async ({ sessionId, claimId, reason }) => {
            const result = reason
                ? await options.repository.releaseClaim(sessionId, claimId, reason)
                : await options.repository.releaseClaim(sessionId, claimId);
            options.facts.handle(result.facts);
        },
        consume: async ({ sessionId, claimId, reason }) => {
            const result = await options.repository.consumeClaim(sessionId, claimId, reason);
            options.facts.handle(result.facts);
        },
        cancelClaim: async ({ sessionId, claimId }) => {
            const result = await options.repository.cancelClaim(sessionId, claimId);
            options.facts.handle(result.facts);
        },
        reject: async ({ sessionId, claimId, reason }) => {
            const result = await options.repository.rejectClaim(sessionId, claimId, reason);
            options.facts.handle(result.facts);
        },
        recoverClaims: async (sessionId, scope) => {
            const result = scope
                ? await options.repository.recoverClaims(sessionId, options.acceptance, scope)
                : await options.repository.recoverClaims(sessionId, options.acceptance);
            options.facts.handle(result.facts);
        },
    };
}
function toDispatchClaim(item) {
    return {
        claimId: item.claimId,
        sessionId: item.sessionId,
        source: item.source,
        claimOwnerId: item.claimOwnerId,
        claimLeaseExpiresAt: item.claimLeaseExpiresAt,
        selection: item.selection,
        item: item.item,
        message: item.message,
        provenance: item.provenance,
        ...(item.clientRequestId ? { clientRequestId: item.clientRequestId } : {}),
    };
}
//# sourceMappingURL=dispatch-capability.js.map