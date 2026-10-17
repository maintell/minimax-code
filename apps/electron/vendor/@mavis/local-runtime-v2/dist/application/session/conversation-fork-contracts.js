export class ForkServiceError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.code = code;
        this.name = 'ForkServiceError';
    }
}
//# sourceMappingURL=conversation-fork-contracts.js.map