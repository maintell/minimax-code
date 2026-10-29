const STATUS = {
    LOCAL_HOOK_SCOPE_INVALID: 400,
    LOCAL_HOOK_PROJECT_DIR_INVALID: 400,
    LOCAL_HOOK_DEFINITION_INVALID: 400,
    LOCAL_HOOK_NOT_FOUND: 404,
    LOCAL_HOOK_CONFIG_CONFLICT: 409,
    LOCAL_HOOK_CONFIG_INVALID: 409,
    LOCAL_HOOK_LIMIT_EXCEEDED: 400,
};
export class HookConfigError extends Error {
    code;
    status;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'HookConfigError';
        this.status = STATUS[code];
    }
}
//# sourceMappingURL=errors.js.map