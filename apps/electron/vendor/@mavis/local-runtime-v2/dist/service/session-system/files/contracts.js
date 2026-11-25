export class SessionFileSyncServiceError extends Error {
    reason;
    constructor(reason, message) {
        super(message);
        this.reason = reason;
        this.name = 'SessionFileSyncServiceError';
    }
}
//# sourceMappingURL=contracts.js.map