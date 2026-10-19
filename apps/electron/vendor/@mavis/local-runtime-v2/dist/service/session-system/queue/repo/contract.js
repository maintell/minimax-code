export class QueueDataCorruptionError extends Error {
    sessionId;
    itemId;
    name = 'QueueDataCorruptionError';
    constructor(sessionId, itemId) {
        super(`Queue row is corrupt: ${sessionId}/${itemId}`);
        this.sessionId = sessionId;
        this.itemId = itemId;
    }
}
export class QueueClaimNotFoundError extends Error {
    sessionId;
    claimId;
    name = 'QueueClaimNotFoundError';
    constructor(sessionId, claimId) {
        super(`Queue claim not found: ${sessionId}/${claimId || '<empty>'}`);
        this.sessionId = sessionId;
        this.claimId = claimId;
    }
}
export class QueueClaimNotAcceptedError extends Error {
    sessionId;
    claimId;
    turnId;
    name = 'QueueClaimNotAcceptedError';
    constructor(sessionId, claimId, turnId) {
        super(`Queue claim is not durably accepted: ${sessionId}/${claimId}`);
        this.sessionId = sessionId;
        this.claimId = claimId;
        this.turnId = turnId;
    }
}
export class QueueEnqueueAdmissionError extends Error {
    sessionId;
    reason;
    name = 'QueueEnqueueAdmissionError';
    constructor(sessionId, reason) {
        super(`Queue enqueue admission rejected: ${sessionId}/${reason}`);
        this.sessionId = sessionId;
        this.reason = reason;
    }
}
//# sourceMappingURL=contract.js.map