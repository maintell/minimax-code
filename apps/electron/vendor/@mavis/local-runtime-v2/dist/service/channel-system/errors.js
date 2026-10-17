export class LocalChannelRootlessError extends Error {
    status;
    code;
    imRoute;
    constructor(status, code, message, imRoute) {
        super(message);
        this.status = status;
        this.code = code;
        this.imRoute = imRoute;
        this.name = 'LocalChannelRootlessError';
    }
}
export function multiProjectBindingError() {
    return new LocalChannelRootlessError(409, 'CHANNEL_BINDING_MULTI_PROJECT', 'One Channel binding profile cannot target multiple Projects.');
}
//# sourceMappingURL=errors.js.map