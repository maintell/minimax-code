import { LLM_ERROR_CODES } from '@mavis/shared/llm-error-classifier';
const RETRYABLE_RUNTIME_ERROR_CODES = new Set([
    LLM_ERROR_CODES.LLM_RATE_LIMITED,
    LLM_ERROR_CODES.LLM_UPSTREAM_ERROR,
    LLM_ERROR_CODES.LLM_TPM_RATE_LIMITED,
    LLM_ERROR_CODES.LLM_CLUSTER_OVERLOADED,
]);
export function isProductionRuntimeErrorRetryable(errorCode) {
    return errorCode !== undefined && RETRYABLE_RUNTIME_ERROR_CODES.has(errorCode);
}
//# sourceMappingURL=runtime-error-retry-policy.js.map