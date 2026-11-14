import { combineAgentEventObservers, } from '../../service/turn-system/index.js';
/**
 * Feeds the auto-resume owner from Turn facts: lifecycle events carry the
 * quota code and tell the owner the user came back, and the post-settlement
 * hook is the only place a plan may be recorded. The hook never rejects, so a
 * Turn outcome can never change because of it.
 */
export function withQuotaAutoResumeProduct(product, observer) {
    const baseSettlement = product.turnSettlement;
    return {
        ...product,
        eventObserver: combineAgentEventObservers(product.eventObserver, observer),
        turnSettlement: {
            settle: async (input) => {
                await baseSettlement?.settle(input);
                await observer.settlement.settle(input);
            },
            ...(baseSettlement?.abandon ? { abandon: baseSettlement.abandon } : {}),
        },
    };
}
//# sourceMappingURL=quota-auto-resume-product.js.map