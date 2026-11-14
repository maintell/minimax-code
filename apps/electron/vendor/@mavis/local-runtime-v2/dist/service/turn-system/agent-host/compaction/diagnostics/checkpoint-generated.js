const CHECKPOINT_CONTENT_KINDS = new Set([
    'text',
    'thinking',
    'toolCall',
    'unknown',
]);
const CHECKPOINT_STOP_REASONS = new Set([
    'stop',
    'length',
    'toolUse',
    'error',
    'aborted',
]);
function captureCheckpointGenerationMetadata(value) {
    if (!Array.isArray(value.responseContentKinds) ||
        !CHECKPOINT_STOP_REASONS.has(value.stopReason) ||
        !Number.isSafeInteger(value.outputTokens) ||
        value.outputTokens < 0) {
        return undefined;
    }
    const responseContentKinds = [
        ...new Set(value.responseContentKinds.filter((kind) => CHECKPOINT_CONTENT_KINDS.has(kind))),
    ];
    return Object.freeze({
        responseContentKinds: Object.freeze(responseContentKinds),
        stopReason: value.stopReason,
        outputTokens: value.outputTokens,
        ...(value.requestShape === 'shared_prefix' || value.requestShape === 'isolated'
            ? { requestShape: value.requestShape }
            : {}),
    });
}
export function logCheckpointGeneratedBestEffort(logger, input) {
    let checkpoint;
    try {
        checkpoint = captureCheckpointGenerationMetadata(input.checkpoint);
        if (!checkpoint)
            return undefined;
        logger?.info?.({
            event: 'context_compaction_checkpoint_generated',
            session_id: input.context.sessionId,
            turn_id: input.context.turnId,
            turn_sequence: input.context.turnSequence,
            attempt_id: input.attemptId,
            phase: input.phase,
            thinking_level: input.thinkingLevel,
            response_content_kinds: [...checkpoint.responseContentKinds],
            stop_reason: checkpoint.stopReason,
            output_tokens: checkpoint.outputTokens,
            ...(checkpoint.requestShape ? { request_shape: checkpoint.requestShape } : {}),
        }, '[local-runtime-v2] context compaction checkpoint generated');
    }
    catch {
        // Engineering diagnostics must never change the compaction outcome.
    }
    return checkpoint;
}
//# sourceMappingURL=checkpoint-generated.js.map