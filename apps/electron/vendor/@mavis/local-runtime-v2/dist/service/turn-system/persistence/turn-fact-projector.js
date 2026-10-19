class TurnFactAssociationError extends Error {
    turnId;
    name = 'TurnFactAssociationError';
    constructor(turnId) {
        super(`Agent event does not match the durable Turn receipt: ${turnId}.`);
        this.turnId = turnId;
    }
}
/**
 * Confirms every AgentHost callback against the durable admission fact. The
 * Turn repository remains the source of truth for the accepted sequence; this
 * projector intentionally writes no second event ledger.
 */
export function createTurnFactProjector(repository) {
    const assertAssociated = async (context) => {
        const receipt = await repository.findReceipt(context.turnId);
        if (!receipt ||
            receipt.sessionId !== context.sessionId ||
            receipt.acceptedSequence !== context.turnSequence) {
            throw new TurnFactAssociationError(context.turnId);
        }
    };
    return {
        projectRuntimeEvent: ({ context }) => assertAssociated(context),
        projectHistoryCommitted: (input) => assertAssociated(input.context),
    };
}
//# sourceMappingURL=turn-fact-projector.js.map