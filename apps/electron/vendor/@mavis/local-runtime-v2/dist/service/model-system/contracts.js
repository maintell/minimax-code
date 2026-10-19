export class LocalModelProviderError extends Error {
    status;
    code;
    name = 'LocalModelProviderError';
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code;
    }
}
//# sourceMappingURL=contracts.js.map