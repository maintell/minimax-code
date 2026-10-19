export class SessionServiceError extends Error {
    reason;
    detailCode;
    constructor(reason, message, detailCode) {
        super(message);
        this.reason = reason;
        this.detailCode = detailCode;
        this.name = 'SessionServiceError';
    }
}
export class SessionQueryServiceError extends Error {
    reason;
    constructor(reason, message) {
        super(message);
        this.reason = reason;
        this.name = 'SessionQueryServiceError';
    }
}
//# sourceMappingURL=errors.js.map