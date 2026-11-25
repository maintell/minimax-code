export class ContinuationHistoryValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ContinuationHistoryValidationError';
    }
}
export const SHARE_CONTEXT_BASIS_UNAVAILABLE = 'SHARE_CONTEXT_BASIS_UNAVAILABLE';
export class ShareContextBasisUnavailableError extends Error {
    code = SHARE_CONTEXT_BASIS_UNAVAILABLE;
    constructor(reason) {
        super(`${SHARE_CONTEXT_BASIS_UNAVAILABLE}: ${reason}`);
        this.name = 'ShareContextBasisUnavailableError';
    }
}
//# sourceMappingURL=continuation-errors.js.map