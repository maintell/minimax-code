export class LlmContextInspectorServiceError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
        this.name = 'LlmContextInspectorServiceError';
    }
}
//# sourceMappingURL=errors.js.map