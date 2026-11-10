import { ProtocolErrorCode } from '@mavis/protocol';
import { LLM_ERROR_CODES } from '@mavis/shared/llm-error-classifier';
/**
 * Collapse transport/provider failures into the bounded Goal settlement
 * catalog. Raw provider text is used only for classification and is never
 * persisted as a Goal status reason.
 */
export function classifyThreadGoalFailure(input) {
    const code = Number(input?.code);
    const message = `${input?.message ?? ''} ${input?.details ?? ''}`.trim().toLowerCase();
    if (isProviderQuotaFailure(code, message))
        return 'provider_quota';
    if (isRateLimitFailure(code, message))
        return 'rate_limit';
    if (isSafetyFailure(code, message))
        return 'safety';
    if (isRetryableInfraFailure(code, message))
        return 'infra_retryable';
    return 'unknown';
}
const PROVIDER_QUOTA_CODES = new Set([
    LLM_ERROR_CODES.USAGE_LIMIT_EXCEEDED,
    LLM_ERROR_CODES.LLM_CREDITS_EXHAUSTED,
]);
const RATE_LIMIT_CODES = new Set([
    LLM_ERROR_CODES.LLM_RATE_LIMITED,
    LLM_ERROR_CODES.LLM_TPM_RATE_LIMITED,
    429,
]);
const RETRYABLE_INFRA_CODES = new Set([
    ProtocolErrorCode.TIMEOUT,
    ProtocolErrorCode.RUNTIME_UNAVAILABLE,
    ProtocolErrorCode.INTERNAL,
    ProtocolErrorCode.SAFETY_UNAVAILABLE,
    LLM_ERROR_CODES.LLM_UPSTREAM_ERROR,
    LLM_ERROR_CODES.LLM_CLUSTER_OVERLOADED,
]);
function isProviderQuotaFailure(code, message) {
    return (PROVIDER_QUOTA_CODES.has(code) ||
        /\b(?:quota|credits? exhausted|insufficient (?:balance|credits?)|usage limit)\b/u.test(message));
}
function isRateLimitFailure(code, message) {
    return (RATE_LIMIT_CODES.has(code) ||
        /\b(?:rate limit|rate_limited|too many requests|tpm|rpm)\b/u.test(message));
}
function isSafetyFailure(code, message) {
    return (code === ProtocolErrorCode.SAFETY_SENSITIVE ||
        /\b(?:content[_ -]?filter|safety sensitive|sensitive content|policy violation)\b/u.test(message));
}
function isRetryableInfraFailure(code, message) {
    return (RETRYABLE_INFRA_CODES.has(code) ||
        (code >= 500 && code <= 599) ||
        /\b(?:timeout|timed out|network|upstream|overload|temporar(?:y|ily) unavailable)\b/u.test(message));
}
//# sourceMappingURL=failure-classification.js.map