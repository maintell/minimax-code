import { writeQueryCollapseView, } from '../../service/session-system/index.js';
const continuationObservations = new WeakSet();
export class TurnContinuationDeliveryService {
    options;
    constructor(options) {
        this.options = options;
    }
    async open(sessionId) {
        const reservation = this.options.stream.reserve(sessionId);
        try {
            const result = await this.options.turns.continueTurn({
                sessionId,
                onAccepted: async ({ turnId }) => {
                    reservation.bindTurn(turnId);
                    await startContinuationQuery(this.options, sessionId, turnId);
                },
            });
            if (!result.accepted) {
                reservation.discardIfEmpty();
                return result;
            }
            continuationObservations.add(completeAfterSettlement(result.completion, reservation.complete));
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
}
async function startContinuationQuery(options, sessionId, turnId) {
    try {
        const queryKey = await options.queryCollapse.resolve(sessionId, turnId);
        const state = await options.queryCollapse.start({
            sessionId,
            queryKey,
            currentTurnId: turnId,
        });
        writeQueryCollapseView(options.stream, state);
    }
    catch {
        // Query collapse is an optional display sidecar and cannot reject continuation admission.
    }
}
async function completeAfterSettlement(completion, complete) {
    try {
        await completion;
    }
    finally {
        complete();
    }
}
//# sourceMappingURL=turn-continuation-delivery.js.map