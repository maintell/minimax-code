export class SessionHandoffError extends Error {
    code;
    retryable;
    diagnostic;
    constructor(code, message, retryable = false, diagnostic) {
        super(message);
        this.code = code;
        this.retryable = retryable;
        this.diagnostic = diagnostic;
        this.name = 'SessionHandoffError';
    }
}
/** Phase classification never grants a retry that the underlying operation rejected. */
export function classifyHandoffStageError(stage, error) {
    const codes = {
        cloud_prepare: 'HANDOFF_CLOUD_PREPARE_FAILED',
        cloud_prepare_validation: 'HANDOFF_CLOUD_PREPARE_FAILED',
        artifact_upload: 'HANDOFF_UPLOAD_FAILED',
        workspace_upload: 'HANDOFF_UPLOAD_FAILED',
        materializing: 'HANDOFF_MATERIALIZATION_FAILED',
        cloud_commit: 'HANDOFF_COMMIT_FAILED',
    };
    if (!Object.hasOwn(codes, stage))
        return error;
    if (!stage.startsWith('cloud_prepare') &&
        error instanceof SessionHandoffError &&
        error.code !== 'HANDOFF_UNAVAILABLE')
        return error;
    return new SessionHandoffError(codes[stage], 'Cloud handoff stage failed', error instanceof SessionHandoffError && error.retryable, error instanceof SessionHandoffError ? error.diagnostic : undefined);
}
//# sourceMappingURL=errors.js.map