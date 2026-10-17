import { classifyLLMErrorToCode, toLLMProtocolClassification, } from '@mavis/shared/llm-error-classifier';
/**
 * Exported alias for unit testing — the LLM-error classify branch is
 * significant enough to merit a focused regression test.
 */
export function _computeFailureTerminationReasonForTest(runError) {
    return failureReason(runError);
}
export function failureReason(runError, normalized) {
    const message = runError ?? 'pi-turn-runner: unknown failure';
    const projected = normalized ? toLLMProtocolClassification(normalized) : null;
    const classified = projected
        ? { status_code: projected.code, message: projected.message ?? message }
        : classifyLLMErrorToCode(message);
    if (classified !== null) {
        const protocolError = {
            code: classified.status_code,
            message: classified.message,
        };
        return { kind: 'failed', message: classified.message, error: protocolError };
    }
    return { kind: 'failed', message };
}
//# sourceMappingURL=terminal.js.map