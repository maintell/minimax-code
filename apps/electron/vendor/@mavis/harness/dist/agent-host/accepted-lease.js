const trustedAbortSignalBrand = captureAbortSignalBrand();
export class AgentHostTurnSequenceError extends Error {
    acceptedSequence;
    name = 'AgentHostTurnSequenceError';
    constructor(acceptedSequence) {
        super('AgentHost acceptedSequence must be a finite positive integer.');
        this.acceptedSequence = acceptedSequence;
    }
}
export class AgentHostTurnLeaseError extends Error {
    reason;
    name = 'AgentHostTurnLeaseError';
    constructor(reason) {
        super(`AgentHost accepted Turn lease is invalid: ${reason}.`);
        this.reason = reason;
    }
}
export function hasAcceptedLeaseIdentity(turn) {
    return [turn.sessionId, turn.turnId, turn.leaseId].every(isNonEmptyString);
}
export function isAbortSignalLike(value) {
    if (typeof value !== 'object' || value === null || !trustedAbortSignalBrand) {
        return false;
    }
    try {
        const aborted = Reflect.apply(trustedAbortSignalBrand.abortedGetter, value, []);
        if (typeof aborted !== 'boolean')
            return false;
        return (typeof Reflect.get(value, 'addEventListener') === 'function' &&
            typeof Reflect.get(value, 'removeEventListener') === 'function');
    }
    catch {
        return false;
    }
}
function captureAbortSignalBrand() {
    if (typeof AbortSignal === 'undefined')
        return undefined;
    const abortedGetter = Reflect.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
    return abortedGetter ? { abortedGetter } : undefined;
}
function isNonEmptyString(value) {
    return typeof value === 'string' && Boolean(value.trim());
}
function validateAcceptedSequence(acceptedSequence) {
    if (typeof acceptedSequence !== 'number' ||
        !Number.isFinite(acceptedSequence) ||
        !Number.isSafeInteger(acceptedSequence) ||
        acceptedSequence <= 0) {
        throw new AgentHostTurnSequenceError(acceptedSequence);
    }
}
export function captureAcceptedTurnLease(value) {
    if (!value || typeof value !== 'object') {
        throw new AgentHostTurnLeaseError('identity');
    }
    const candidate = {
        sessionId: readUnknownProperty(value, 'sessionId'),
        turnId: readUnknownProperty(value, 'turnId'),
        leaseId: readUnknownProperty(value, 'leaseId'),
        acceptedSequence: readUnknownProperty(value, 'acceptedSequence'),
        acceptedAtMs: readUnknownProperty(value, 'acceptedAtMs'),
        signal: readUnknownProperty(value, 'signal'),
        busyReason: readUnknownProperty(value, 'busyReason'),
    };
    if (!hasAcceptedLeaseIdentity(candidate)) {
        throw new AgentHostTurnLeaseError('identity');
    }
    if (candidate.busyReason !== 'turn') {
        throw new AgentHostTurnLeaseError('busy-reason');
    }
    if (!isAcceptedAtMs(candidate.acceptedAtMs)) {
        throw new AgentHostTurnLeaseError('identity');
    }
    if (!isAbortSignalLike(candidate.signal)) {
        throw new AgentHostTurnLeaseError('signal');
    }
    validateAcceptedSequence(candidate.acceptedSequence);
    return Object.freeze({
        sessionId: candidate.sessionId,
        turnId: candidate.turnId,
        leaseId: candidate.leaseId,
        acceptedSequence: candidate.acceptedSequence,
        acceptedAtMs: candidate.acceptedAtMs,
        signal: candidate.signal,
        busyReason: candidate.busyReason,
    });
}
export function readUnknownProperty(value, key) {
    return Reflect.get(value, key);
}
function isAcceptedAtMs(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
//# sourceMappingURL=accepted-lease.js.map