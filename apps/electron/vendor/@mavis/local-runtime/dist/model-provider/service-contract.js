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
//# sourceMappingURL=service-contract.js.map