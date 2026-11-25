export class HistoryMutationError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.code = code;
        this.name = 'HistoryMutationError';
    }
}
export function boundaryNotFound(boundary) {
    throw new HistoryMutationError('boundary-not-found', `History mutation target not found: ${boundary}`);
}
//# sourceMappingURL=history-mutation-error.js.map