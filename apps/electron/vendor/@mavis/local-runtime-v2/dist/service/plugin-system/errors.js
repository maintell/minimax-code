export class PluginSystemError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.code = code;
        this.name = 'PluginSystemError';
        if (options?.reasonCode !== undefined)
            this.reasonCode = options.reasonCode;
    }
}
//# sourceMappingURL=errors.js.map