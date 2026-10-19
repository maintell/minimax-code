export class AgentServiceError extends Error {
    code;
    details;
    status;
    constructor(code, message, status = statusFor(code), details) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = 'AgentServiceError';
        this.status = status;
    }
}
function statusFor(code) {
    return {
        AGENT_NAME_REQUIRED: 400,
        AGENT_NAME_INVALID: 400,
        AGENT_REQUEST_REF_INVALID: 400,
        AGENT_NOT_FOUND: 404,
        AGENT_CONFIG_NOT_FOUND: 409,
        AGENT_CONFIG_INVALID: 422,
        AGENT_CONFIG_UNSTABLE: 409,
        AGENT_CONFIG_AVATAR_INVALID: 422,
        AGENT_CONFIG_EDIT_UNSUPPORTED: 409,
        AGENT_CONFIG_REVISION_CONFLICT: 409,
        AGENT_CONFIG_INSTANCE_CONFLICT: 409,
        AGENT_CONFIG_INSTANCE_REQUIRED: 400,
        AGENT_IMPORT_SECRET_FORBIDDEN: 422,
        AGENT_IMPORT_DIGEST_MISMATCH: 409,
        AGENT_IMPORT_ISSUES_UNACCEPTED: 422,
        CANONICAL_AGENT_NOT_AVAILABLE: 503,
        LEGACY_HISTORY_UNAVAILABLE: 503,
        BUILTIN_AGENT_NAME_CONFLICT: 409,
        AGENT_NAME_CONFLICT: 409,
        AMBIGUOUS_AGENT_NAME: 409,
        BUILTIN_AGENT_IMMUTABLE: 403,
        BUILTIN_AGENT_DELETE_FORBIDDEN: 403,
        PRIMARY_AGENT_IMMUTABLE: 403,
        PRIMARY_AGENT_IDENTITY_CONFLICT: 409,
        LEGACY_PRIMARY_WRITE_FORBIDDEN: 403,
        AGENT_ROLE_CONFLICT: 409,
        CONTENT_POLICY_VIOLATION: 422,
        VALIDATION_ERROR: 400,
    }[code];
}
//# sourceMappingURL=errors.js.map