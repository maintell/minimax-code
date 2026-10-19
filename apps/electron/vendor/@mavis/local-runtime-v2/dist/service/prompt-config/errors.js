export class PromptConfigError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'PromptConfigError';
    }
}
/** A remote snapshot cannot be used as a complete prompt source for this call. */
export class PromptSnapshotInvalidError extends PromptConfigError {
    constructor(message = 'Prompt snapshot is invalid') {
        super('PROMPT_SNAPSHOT_INVALID', message);
        this.name = 'PromptSnapshotInvalidError';
    }
}
export function isPromptSnapshotInvalidError(error) {
    return error instanceof PromptSnapshotInvalidError;
}
//# sourceMappingURL=errors.js.map