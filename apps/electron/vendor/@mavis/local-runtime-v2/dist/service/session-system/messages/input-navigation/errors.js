export class SessionInputSummaryServiceError extends Error {
    reason;
    constructor(reason, message) {
        super(message);
        this.reason = reason;
        this.name = 'SessionInputSummaryServiceError';
    }
}
//# sourceMappingURL=errors.js.map