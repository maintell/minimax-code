const STABLE_COMPACTION_FAILURES = [
    ['INVALID_HISTORY', 'history'],
    ['INVALID_CHECKPOINT', 'llm_checkpoint'],
    ['CHECKPOINT_PROVIDER_FAILED', 'llm_checkpoint'],
    ['COMPACTION_INPUT_TOO_LARGE', 'llm_checkpoint'],
    ['POST_ADMISSION_FAILED', 'post_admission'],
];
export function logCompactionFailureBestEffort(logger, input) {
    try {
        const failure = captureStableCompactionFailure(input.error) ??
            (input.checkpoint?.stopReason === 'aborted'
                ? ['COMPACTION_ABORTED', 'llm_checkpoint']
                : undefined);
        logger?.error?.({
            event: 'context_compaction_failed',
            session_id: input.context.sessionId,
            turn_id: input.context.turnId,
            turn_sequence: input.context.turnSequence,
            attempt_id: input.attemptId,
            phase: input.phase,
            thinking_level: input.thinkingLevel,
            ...(input.checkpoint === undefined
                ? {}
                : {
                    response_content_kinds: [...input.checkpoint.responseContentKinds],
                    stop_reason: input.checkpoint.stopReason,
                    output_tokens: input.checkpoint.outputTokens,
                }),
            error_code: failure?.[0] ?? 'UNKNOWN_ERROR',
            error_stage: failure?.[1] ?? 'unknown',
            ...captureCompactionSizeDiagnosticsFields(input.error),
        }, '[local-runtime-v2] context compaction failed');
    }
    catch {
        // Engineering diagnostics must never change the compaction outcome.
    }
}
const COMPACTION_SIZE_DIAGNOSTIC_FIELDS = [
    ['historyMessageCount', 'history_message_count'],
    ['protectedMessageCount', 'protected_message_count'],
    ['protectedInputTokens', 'protected_input_tokens'],
    ['protectedSerializedBytes', 'protected_serialized_bytes'],
    ['providerInputLimit', 'provider_input_limit'],
    ['maxSerializedInputBytes', 'max_serialized_input_bytes'],
    ['beforeInputTokens', 'before_input_tokens'],
    ['beforeSerializedBytes', 'before_serialized_bytes'],
    ['afterInputTokens', 'after_input_tokens'],
    ['afterSerializedBytes', 'after_serialized_bytes'],
];
/** Content-free sizing facts attached by the compaction algorithm, when present. */
function captureCompactionSizeDiagnosticsFields(error) {
    try {
        if (error === null || typeof error !== 'object')
            return {};
        const diagnostics = Reflect.get(error, 'diagnostics');
        if (!isRecord(diagnostics))
            return {};
        const fields = {};
        for (const [source, target] of COMPACTION_SIZE_DIAGNOSTIC_FIELDS) {
            const value = diagnostics[source];
            if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
                fields[target] = value;
            }
        }
        const hminAvailable = diagnostics['hminAvailable'];
        if (typeof hminAvailable === 'boolean')
            fields['hmin_available'] = hminAvailable;
        return fields;
    }
    catch {
        return {};
    }
}
function captureStableCompactionFailure(error) {
    if (error === null || typeof error !== 'object')
        return undefined;
    try {
        const code = Reflect.get(error, 'code');
        const stage = Reflect.get(error, 'stage');
        return STABLE_COMPACTION_FAILURES.find(([stableCode, stableStage]) => code === stableCode && stage === stableStage);
    }
    catch {
        return undefined;
    }
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=compaction-failure.js.map