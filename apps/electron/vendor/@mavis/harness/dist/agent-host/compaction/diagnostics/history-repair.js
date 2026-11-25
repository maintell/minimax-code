const HISTORY_REPAIRED_MESSAGE = '[local-runtime-v2] context compaction left unpaired tool calls out of the checkpoint';
/**
 * `compact_history_repaired_total{phase}`, mirrored from
 * packages/shared/src/local-runtime-logging/metric-registry.ts. The registry is a Host module the
 * orchestration core must not reach, so the count goes through the injected metrics port; a
 * registry change to the name or the label set is not compile-checked here.
 */
const HISTORY_REPAIRED_METRIC_NAME = 'compact_history_repaired_total';
/**
 * Compaction kept going on a history whose tool calls and results did not pair (legacy v1
 * histories, interrupted turns) and summarized only the paired part. Logged as a warning (info
 * when the host logger has no warn) with counts and the fixed pairing-violation text; history
 * content never leaves this function.
 */
export function recordHistoryRepairBestEffort(logger, metrics, input) {
    try {
        const fields = {
            event: 'context_compaction_history_repaired',
            session_id: input.context.sessionId,
            turn_id: input.context.turnId,
            turn_sequence: input.context.turnSequence,
            attempt_id: input.attemptId,
            phase: input.phase,
            violation: input.repair.violation,
            dropped_tool_calls: input.repair.droppedToolCalls,
            dropped_tool_results: input.repair.droppedToolResults,
            dropped_assistant_messages: input.repair.droppedAssistantMessages,
        };
        if (logger?.warn)
            logger.warn(fields, HISTORY_REPAIRED_MESSAGE);
        else
            logger?.info?.(fields, HISTORY_REPAIRED_MESSAGE);
    }
    catch {
        // Engineering diagnostics must never change the compaction outcome.
    }
    if (!metrics)
        return;
    try {
        metrics.counter(HISTORY_REPAIRED_METRIC_NAME, 1, { phase: input.phase });
    }
    catch {
        // Metrics must never change the compaction outcome.
    }
}
//# sourceMappingURL=history-repair.js.map