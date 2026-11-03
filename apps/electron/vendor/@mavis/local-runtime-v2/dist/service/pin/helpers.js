export class LocalPinContractError extends Error {
    status;
    code;
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code;
        this.name = 'LocalPinContractError';
    }
}
//# sourceMappingURL=helpers.js.map