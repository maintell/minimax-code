const RECOVERABLE_SERVER_EXECUTION_ERRORS = new Set([
    'workspace_indexing_failed',
    'workspace_indexing_timeout',
    'workspace_storage_failed',
]);
export function isRecoverableServerExecutionError(code) {
    return RECOVERABLE_SERVER_EXECUTION_ERRORS.has(code);
}
export function normalizeWorkspaceRemoteErrorCode(error) {
    if (error &&
        typeof error === 'object' &&
        typeof error.code === 'string') {
        return error.code;
    }
    return error instanceof Error && error.name ? error.name : 'workspace_remote_failed';
}
//# sourceMappingURL=remote-error.js.map