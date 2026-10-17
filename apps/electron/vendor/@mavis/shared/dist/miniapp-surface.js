/** Bounds one untrusted page request; input behavior remains owned by the chat input. */
export const MINIAPP_COMPOSER_MAX_TEXT_LENGTH = 100_000;
const MINIAPP_COMPOSER_FAILURE_CODES = [
    'user_cancelled',
    'invalid_request',
    'text_too_large',
    'not_allowed',
    'target_unavailable',
    'result_unknown',
];
/** Both IPC boundaries use the same allowlist and discard all non-contract fields. */
export function parseMiniAppComposerAppendResult(value) {
    if (!value || typeof value !== 'object')
        return null;
    const result = value;
    if (result.success === true)
        return { success: true };
    const code = MINIAPP_COMPOSER_FAILURE_CODES.find((candidate) => candidate === result.code);
    return result.success === false && code ? { success: false, code } : null;
}
//# sourceMappingURL=miniapp-surface.js.map