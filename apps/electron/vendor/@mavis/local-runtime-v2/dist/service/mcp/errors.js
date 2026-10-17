export class LocalMcpSettingsError extends Error {
    status;
    code;
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code;
        this.name = 'LocalMcpSettingsError';
    }
}
//# sourceMappingURL=errors.js.map