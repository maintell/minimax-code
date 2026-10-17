/** Safe, durable display contract. Technical exception text never enters history. */
export class HandoffPreparationError extends Error {
    publicFailure;
    constructor(code, message = 'Cloud handoff preparation failed') {
        super(message);
        this.name = 'HandoffPreparationError';
        this.publicFailure = { code, message };
    }
}
const PREPARATION_CODES = new Set([
    'HANDOFF_HISTORY_TOO_LARGE',
    'HANDOFF_HISTORY_UNAVAILABLE',
    'HANDOFF_HISTORY_INVALID',
    'HANDOFF_SCAN_TOO_LARGE',
    'HANDOFF_SCAN_FAILED',
    'HANDOFF_RECOMMENDATION_INVALID',
    'HANDOFF_SESSION_ARCHIVED',
    'HANDOFF_WORKSPACE_REQUIRED',
    'HANDOFF_RUNTIME_UNSUPPORTED',
    'HANDOFF_SUBAGENT_UNSUPPORTED',
    'HANDOFF_SESSION_STATE_INVALID',
    'HANDOFF_PREFLIGHT_UNAVAILABLE',
    'HANDOFF_PREFLIGHT_CHECK_FAILED',
]);
export function preparationFailure(error) {
    if (error instanceof HandoffPreparationError)
        return error;
    const record = error && typeof error === 'object' ? error : {};
    const code = typeof record.key === 'string' ? record.key : record.code;
    return new HandoffPreparationError(typeof code === 'string' && PREPARATION_CODES.has(code)
        ? code
        : 'HANDOFF_PREFLIGHT_UNAVAILABLE');
}
//# sourceMappingURL=preparation-error.js.map