import { EvalTurnStatus } from '@mavis/shared/session-clio';
const CLIO_STATUS_BY_TERMINAL = {
    completed: EvalTurnStatus.Completed,
    failed: EvalTurnStatus.Failed,
    aborted: EvalTurnStatus.Canceled,
};
/**
 * Finalizes the QA record from the Turn's real runtime terminal.
 *
 * This runs on the coordinator's required settlement path, not on a detached
 * observer, so the record is written while the Turn is still settling rather
 * than in a fan-out that is never drained at shutdown. It runs before the
 * product participant and never throws, so a capture problem can neither skip
 * the product's settlement nor change the Turn's outcome.
 *
 * The status is the coordinator's own terminal — the same value written to
 * durable Turn state — and never the eval reporter's, which deliberately
 * reports retraction and network stops as aborted while the host still commits
 * a completed terminal.
 */
export function withSessionClioTurnSettlement(capture, product) {
    return {
        settle: async (input) => {
            await capture.finalizeTurn({
                sessionId: input.sessionId,
                turnId: input.turnId,
                status: CLIO_STATUS_BY_TERMINAL[input.status],
            });
            await product?.settle(input);
        },
        ...(product?.abandon ? { abandon: product.abandon.bind(product) } : {}),
    };
}
//# sourceMappingURL=turn-settlement.js.map