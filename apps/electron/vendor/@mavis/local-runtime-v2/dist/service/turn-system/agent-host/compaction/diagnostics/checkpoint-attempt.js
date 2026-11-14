const CHECKPOINT_CANDIDATES = new Set([
    'h0',
    'hall',
    'hvideo',
    'hmid',
    'hmin',
]);
const CHECKPOINT_ATTEMPT_OUTCOMES = new Set([
    'generated',
    'input_too_large',
    'output_exhausted',
    'aborted',
    'failed',
]);
export function recordCheckpointAttemptBestEffort(logger, metrics, input) {
    const checkpoint = captureCheckpointAttemptMetadata(input.checkpoint);
    if (!checkpoint)
        return;
    try {
        logger?.info?.({
            event: 'context_compaction_checkpoint_attempt_settled',
            session_id: input.context.sessionId,
            turn_id: input.context.turnId,
            turn_sequence: input.context.turnSequence,
            attempt_id: input.attemptId,
            phase: input.phase,
            thinking_level: input.thinkingLevel,
            checkpoint_candidate: checkpoint.candidate,
            checkpoint_attempt: checkpoint.attemptNumber,
            ...checkpointAttemptLogFields(checkpoint),
            outcome: checkpoint.outcome,
            duration_ms: checkpoint.durationMs,
        }, '[local-runtime-v2] context compaction checkpoint attempt settled');
    }
    catch {
        // Engineering diagnostics must never change the compaction outcome.
    }
    try {
        metrics?.counter('compact_checkpoint_candidate_total', 1, {
            candidate: checkpoint.candidate,
            outcome: checkpoint.outcome,
        });
    }
    catch {
        // Metrics must never change the compaction outcome.
    }
    try {
        metrics?.histogram('compact_checkpoint_candidate_duration_ms', checkpoint.durationMs, {
            candidate: checkpoint.candidate,
        });
    }
    catch {
        // Metrics must never change the compaction outcome.
    }
}
function checkpointAttemptLogFields(checkpoint) {
    return {
        ...(checkpoint.inputMessageCount === undefined
            ? {}
            : { input_message_count: checkpoint.inputMessageCount }),
    };
}
function captureCheckpointAttemptMetadata(value) {
    if (!isRecord(value))
        return undefined;
    try {
        const candidate = Reflect.get(value, 'candidate');
        const attemptNumber = Reflect.get(value, 'attemptNumber');
        const outcome = Reflect.get(value, 'outcome');
        const durationMs = Reflect.get(value, 'durationMs');
        if (!CHECKPOINT_CANDIDATES.has(candidate)) {
            return undefined;
        }
        if (typeof attemptNumber !== 'number' ||
            !Number.isSafeInteger(attemptNumber) ||
            attemptNumber < 1) {
            return undefined;
        }
        if (!CHECKPOINT_ATTEMPT_OUTCOMES.has(outcome)) {
            return undefined;
        }
        if (!isNonNegativeFiniteNumber(durationMs)) {
            return undefined;
        }
        return {
            candidate: candidate,
            attemptNumber,
            outcome: outcome,
            durationMs,
            ...captureCheckpointAttemptDetails(value),
        };
    }
    catch {
        return undefined;
    }
}
function captureCheckpointAttemptDetails(value) {
    const inputMessageCount = readOptionalNonNegativeSafeInteger(value, 'inputMessageCount');
    return inputMessageCount === undefined ? {} : { inputMessageCount };
}
function readOptionalNonNegativeSafeInteger(value, key) {
    const field = Reflect.get(value, key);
    return typeof field === 'number' && Number.isSafeInteger(field) && field >= 0 ? field : undefined;
}
function isNonNegativeFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=checkpoint-attempt.js.map