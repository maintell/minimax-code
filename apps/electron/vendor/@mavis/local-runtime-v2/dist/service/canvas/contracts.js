export class CanvasServiceError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = 'CanvasServiceError';
    }
}
//# sourceMappingURL=contracts.js.map