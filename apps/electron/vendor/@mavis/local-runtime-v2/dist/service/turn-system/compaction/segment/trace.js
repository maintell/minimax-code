/** Trace event names (spec 17.1); payloads carry IDs, enums, counts and durations. */
const COMPACTION_EVENT = 'bunny.compaction';
const SEGMENT_EVENT = 'bunny.segment';
const IDLE_EVENT = 'bunny.idle';
/** One emergency handling of a Turn that was about to fail (spec 12.1). */
const EMERGENCY_EVENT = 'bunny.emergency';
/** One context reset the user asked for in a Bunny main conversation (context reset spec 7.2). */
const CONTEXT_RESET_EVENT = 'bunny.context_reset';
/** Effective remote switch value, read back by verification tooling. */
const CONTEXT_CONFIG_EVENT = 'bunny_context_config';
export function traceSegmentCompaction(sink, sessionId, turnId, fields) {
    report(sink, { sessionId, turnId }, COMPACTION_EVENT, {
        schema: 'mavis.bunny_compaction.v1',
        session_id: sessionId,
        ...(turnId ? { turn_id: turnId } : {}),
        trigger: fields.trigger,
        outcome: fields.outcome,
        background: fields.background,
        ...optional('reason', fields.reason),
        ...optional('request_shape', fields.requestShape),
        ...(fields.segmentId === undefined ? {} : { segment_id: fields.segmentId }),
        ...optional('covered_count', fields.coveredCount),
        ...optional('duration_ms', fields.durationMs),
        ...optional('cache_read_tokens', fields.cacheReadTokens),
        ...optional('cache_write_tokens', fields.cacheWriteTokens),
        ...optional('input_tokens', fields.inputTokens),
        ...optional('output_tokens', fields.outputTokens),
        ...optional('ledger_delta_count', fields.ledgerDeltaCount),
        ...optional('ledger_dropped_count', fields.ledgerDroppedCount),
        ...optional('ledger_revalidated_skip_count', fields.ledgerRevalidatedSkipCount),
        ...optional('media_count', fields.mediaCount),
        ...optional('failure_count', fields.failureCount),
        ...optional('tokens_before', fields.tokensBefore),
        ...optional('tokens_after', fields.tokensAfter),
        ...prefixDifferenceFields(fields.prefixDifference),
        ...(fields.tailOverSoftLine ? { tail_over_soft_line: true } : {}),
        ...sizeTokenFields(fields.sizeTokens),
    });
}
function prefixDifferenceFields(difference) {
    if (!difference)
        return {};
    return {
        prefix_first_difference: difference.section,
        ...optional('prefix_difference_message_index', difference.messageIndex),
        ...optional('main_request_message_count', difference.mainMessageCount),
    };
}
function sizeTokenFields(tokens) {
    if (!tokens)
        return {};
    return {
        header_summary_tokens: tokens.summary,
        header_ledger_tokens: tokens.ledger,
        header_spaces_tokens: tokens.spaces,
        header_status_tokens: tokens.status,
        header_retained_tokens: tokens.retained,
        system_tokens: tokens.system,
        tail_tokens: tokens.tail,
        total_tokens: tokens.total,
        soft_line_tokens: tokens.softLine,
    };
}
export function traceSegmentChange(sink, sessionId, turnId, fields) {
    report(sink, { sessionId, turnId }, SEGMENT_EVENT, {
        schema: 'mavis.bunny_segment.v1',
        session_id: sessionId,
        previous_segment_id: fields.previousSegmentId,
        segment_id: fields.segmentId,
        turn_count: fields.turnCount,
        rebuild_reason: fields.rebuildReason,
    });
}
/** 10.3: idle is only traced, never compacted or prewarmed. */
export function traceSegmentIdle(sink, sessionId, fields) {
    report(sink, { sessionId }, IDLE_EVENT, {
        schema: 'mavis.bunny_idle.v1',
        session_id: sessionId,
        phase: fields.phase,
        idle_ms: fields.idleMs,
        continued: fields.continued,
        ...optional('segment_growth_tokens', fields.segmentGrowthTokens),
        ...optional('segment_growth_messages', fields.segmentGrowthMessages),
    });
}
/**
 * 10.5, spec 13: each switch defaults on and fails open on its own. A missing
 * getter (TUI / CLI), a getter that throws, or a value that is not a boolean
 * all mean on.
 */
export function resolveSegmentContextSwitch(getConfig) {
    let config;
    try {
        config = getConfig?.();
    }
    catch {
        config = undefined;
    }
    const background = config?.backgroundCompaction;
    const emergency = config?.emergencyRebuild;
    return {
        ...(typeof background === 'boolean'
            ? { backgroundCompaction: background, source: 'host' }
            : { backgroundCompaction: true, source: 'default' }),
        ...(typeof emergency === 'boolean'
            ? { emergencyRebuild: emergency, emergencyRebuildSource: 'host' }
            : { emergencyRebuild: true, emergencyRebuildSource: 'default' }),
    };
}
/**
 * Whether the emergency rebuild's handlings run for a Bunny main conversation,
 * resolved the way the compaction coordinator resolves them: both switches on
 * (spec 13.2, 13.3).
 */
export function emergencyRebuildInEffect(getConfig) {
    const resolved = resolveSegmentContextSwitch(getConfig);
    return resolved.backgroundCompaction && resolved.emergencyRebuild;
}
export function traceSegmentContextConfig(sink, sessionId, resolved) {
    report(sink, { sessionId }, CONTEXT_CONFIG_EVENT, {
        schema: 'mavis.bunny_context_config.v1',
        session_id: sessionId,
        background_compaction: resolved.backgroundCompaction,
        source: resolved.source,
        emergency_rebuild: resolved.emergencyRebuild,
        emergency_rebuild_source: resolved.emergencyRebuildSource,
    });
}
/** The trace payload of one emergency handling; the diagnostics record repeats it. */
export function emergencyPayload(sessionId, turnId, fields) {
    return {
        schema: 'mavis.bunny_emergency.v1',
        session_id: sessionId,
        turn_id: turnId,
        action: fields.action,
        category: fields.category,
        level: fields.level,
        result: fields.result,
        ...optional('failure_reason', fields.failureReason),
        ...optional('item', fields.item),
        ...optional('error_code', fields.errorCode),
        replaced_counts: { ...fields.replacedCounts },
        affinity_rotated: fields.affinityRotated,
        ...optional('backup_file', fields.backupFile),
        duration_ms: fields.durationMs,
    };
}
export function traceEmergency(sink, sessionId, turnId, payload) {
    report(sink, { sessionId, turnId }, EMERGENCY_EVENT, payload);
}
/** The trace payload of one context reset; the diagnostics record repeats it. */
export function contextResetPayload(sessionId, turnId, fields) {
    return {
        schema: 'mavis.bunny_context_reset.v1',
        session_id: sessionId,
        turn_id: turnId,
        rebuild_reason: 'user_reset',
        result: fields.result,
        had_running_turn: fields.hadRunningTurn,
        forced_stop: fields.forcedStop,
        affinity_rotated: fields.affinityRotated,
        ...optional('backup_file', fields.backupFile),
        unread_sections: [...fields.unreadSections],
        ...optional('failure_category', fields.failureCategory),
        duration_ms: fields.durationMs,
        ...(fields.previousSegmentId === undefined
            ? {}
            : { previous_segment_id: fields.previousSegmentId }),
        ...optional('segment_id', fields.segmentId),
    };
}
export function traceContextReset(sink, sessionId, turnId, payload) {
    report(sink, { sessionId, turnId }, CONTEXT_RESET_EVENT, payload);
}
function report(sink, target, eventType, payload) {
    if (!sink?.reportRuntimeEvent)
        return;
    const { sessionId, turnId } = target;
    try {
        sink.reportRuntimeEvent(sessionId, {
            eventType,
            payload,
            ...(turnId ? { origin: { turnId } } : {}),
        });
    }
    catch {
        // Trace capture never changes compaction behavior.
    }
}
function optional(key, value) {
    return value === undefined ? {} : { [key]: value };
}
//# sourceMappingURL=trace.js.map