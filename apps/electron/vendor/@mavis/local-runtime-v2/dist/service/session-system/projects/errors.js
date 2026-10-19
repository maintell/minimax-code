export class ProjectServiceError extends Error {
    reason;
    constructor(reason, message) {
        super(message);
        this.reason = reason;
        this.name = 'ProjectServiceError';
    }
}
//# sourceMappingURL=errors.js.map