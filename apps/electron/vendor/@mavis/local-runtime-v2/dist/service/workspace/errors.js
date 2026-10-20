/** Stable error raised when a host-local workspace effect has no adapter. */
export class WorkspaceLocalActionsUnavailableError extends Error {
    operation;
    name = 'WorkspaceLocalActionsUnavailableError';
    code = 'WORKSPACE_LOCAL_ACTIONS_UNAVAILABLE';
    status = 501;
    constructor(operation) {
        super(`${operation} is not available on this runtime host`);
        this.operation = operation;
    }
}
/** Error returned by the host adapter for a rejected local effect. */
export class WorkspaceLocalActionError extends Error {
    status;
    code;
    name = 'WorkspaceLocalActionError';
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}
//# sourceMappingURL=errors.js.map