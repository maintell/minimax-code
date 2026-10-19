const SANDBOX_ERROR_CODES = [
    'SANDBOX_UNSUPPORTED_PLATFORM',
    'SANDBOX_DEPENDENCY_MISSING',
    'SANDBOX_CONFIG_INVALID',
    'SANDBOX_INITIALIZATION_FAILED',
    'SANDBOX_WORKSPACE_INVALID',
    'SANDBOX_WRAP_FAILED',
    'SANDBOX_PERMISSION_UNAVAILABLE',
    'SANDBOX_RESTART_REQUIRED',
    'SANDBOX_CLOSING',
    'SANDBOX_UNAVAILABLE',
    'SANDBOX_UNSUPPORTED_ON_LEGACY_HOST',
];
export class SandboxError extends Error {
    code;
    stage;
    fieldPath;
    name = 'SandboxError';
    constructor(code, stage, message, fieldPath) {
        super(message);
        this.code = code;
        this.stage = stage;
        this.fieldPath = fieldPath;
    }
}
export function isSandboxError(error) {
    return error instanceof SandboxError;
}
//# sourceMappingURL=sandbox-errors.js.map