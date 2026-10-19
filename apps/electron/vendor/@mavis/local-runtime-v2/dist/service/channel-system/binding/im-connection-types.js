export class LocalImConnectionError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
        this.name = 'LocalImConnectionError';
    }
}
//# sourceMappingURL=im-connection-types.js.map