/**
 * Host-facing contracts for programmatic tool calls (PTC).
 *
 * The runtime owns admission, guest projection, and persistence. Agent-core
 * only gives an already-running tool a narrow way to execute another tool
 * through the same Pi lifecycle.
 */
/** Wall clock of a run_code program when the model sets no `timeout_ms`. */
export const PTC_DEFAULT_WALL_CLOCK_MS = 120_000;
/** Largest `timeout_ms` a run_code program may use; larger requests are capped to it. */
export const PTC_MAX_WALL_CLOCK_MS = 3_600_000;
/**
 * The one rule for turning a model-supplied `timeout_ms` into a wall clock.
 * run_code and the batch deadline both use it, so the guest wall clock, the
 * child-call cutoff and a PTC Bash child's timeout derive from one value.
 */
export function resolvePtcWallClock(requested) {
    if (requested === undefined)
        return { ms: PTC_DEFAULT_WALL_CLOCK_MS, source: 'default' };
    if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
        return { ms: PTC_DEFAULT_WALL_CLOCK_MS, source: 'invalid' };
    }
    if (requested > PTC_MAX_WALL_CLOCK_MS)
        return { ms: PTC_MAX_WALL_CLOCK_MS, source: 'capped' };
    return { ms: requested, source: 'requested' };
}
export function createPtcToolFactCollector() {
    const factsByChildCall = new Map();
    return {
        record(childToolCallId, facts) {
            if (!childToolCallId || facts.length === 0)
                return;
            const existing = factsByChildCall.get(childToolCallId) ?? [];
            factsByChildCall.set(childToolCallId, [...existing, ...facts]);
        },
        read(childToolCallId) {
            return [...(factsByChildCall.get(childToolCallId) ?? [])];
        },
    };
}
/**
 * Reads only the trusted PTC envelope on a real Pi run_code tool result. It
 * deliberately does not parse user text, arbitrary tool content, or an
 * untyped `details` object from another tool.
 */
export function readPtcExecutionDetails(message) {
    if (!isRecord(message) || message.role !== 'toolResult' || message.toolName !== 'run_code') {
        return undefined;
    }
    const details = isRecord(message.details) ? message.details : undefined;
    const ptc = details && isRecord(details.ptc) ? details.ptc : undefined;
    if (!ptc ||
        ptc.version !== 1 ||
        !Array.isArray(ptc.child_calls) ||
        !Array.isArray(ptc.retained_facts) ||
        (ptc.host_forced_content !== undefined && typeof ptc.host_forced_content !== 'string')) {
        return undefined;
    }
    const childCalls = ptc.child_calls.filter(isPtcToolCallRecord);
    const retainedFacts = ptc.retained_facts.filter(isPtcRetainedFact);
    if (childCalls.length !== ptc.child_calls.length ||
        retainedFacts.length !== ptc.retained_facts.length) {
        return undefined;
    }
    return {
        version: 1,
        child_calls: childCalls,
        retained_facts: retainedFacts,
        ...(typeof ptc.host_forced_content === 'string'
            ? { host_forced_content: ptc.host_forced_content }
            : {}),
    };
}
export function readPtcToolCallRecords(message) {
    return readPtcExecutionDetails(message)?.child_calls ?? [];
}
/**
 * Reads a terminal PTC child only from a durable RuntimeToolCall-shaped
 * display record. The persisted parent id must agree with the signed child
 * record, so arbitrary result content cannot impersonate a PTC child.
 */
export function readPtcChildExecutionDetails(value) {
    if (!isRecord(value) ||
        !isNonEmptyString(value.tool_call_id) ||
        !isNonEmptyString(value.parent_tool_call_id) ||
        !isRecord(value.result)) {
        return undefined;
    }
    const details = isRecord(value.result.details) ? value.result.details : undefined;
    const ptcChild = details && isRecord(details.ptc_child) ? details.ptc_child : undefined;
    if (!ptcChild ||
        ptcChild.version !== 1 ||
        !isPtcToolCallRecord(ptcChild.record) ||
        !Array.isArray(ptcChild.retained_facts)) {
        return undefined;
    }
    const retainedFacts = ptcChild.retained_facts.filter(isPtcRetainedFact);
    if (retainedFacts.length !== ptcChild.retained_facts.length ||
        ptcChild.record.child_tool_call_id !== value.tool_call_id ||
        ptcChild.record.parent_tool_call_id !== value.parent_tool_call_id) {
        return undefined;
    }
    return {
        version: 1,
        record: ptcChild.record,
        retained_facts: retainedFacts,
    };
}
function isPtcToolCallRecord(value) {
    if (!isRecord(value))
        return false;
    return (isNonEmptyString(value.child_tool_call_id) &&
        isNonEmptyString(value.parent_tool_call_id) &&
        isNonEmptyString(value.tool_name) &&
        (value.input === undefined || isRecord(value.input)) &&
        (value.status === 'completed' || value.status === 'failed' || value.status === 'unknown') &&
        (value.is_error === undefined || typeof value.is_error === 'boolean') &&
        (value.outcome_unknown === undefined || typeof value.outcome_unknown === 'boolean') &&
        (value.result_ref === undefined || isNonEmptyString(value.result_ref)));
}
function isPtcRetainedFact(value) {
    if (!isRecord(value) || typeof value.kind !== 'string')
        return false;
    switch (value.kind) {
        case 'terminate_agent':
            return true;
        case 'outcome_unknown':
            return isNonEmptyString(value.child_tool_call_id);
        case 'child_error':
            return (isNonEmptyString(value.child_tool_call_id) &&
                isNonEmptyString(value.code) &&
                (value.cancelled === undefined || typeof value.cancelled === 'boolean') &&
                (value.tool_error_code === undefined || isPtcToolErrorCode(value.tool_error_code)));
        case 'truncation':
            return (isNonEmptyString(value.child_tool_call_id) &&
                (value.truncated === 'true' || value.truncated === 'unknown') &&
                (value.continuation === undefined || isRecord(value.continuation)));
        case 'background_task':
            return isNonEmptyString(value.child_tool_call_id) && isNonEmptyString(value.task_id);
        case 'bash_exit':
            return (isNonEmptyString(value.child_tool_call_id) &&
                (value.exit_code === null || isSafeInteger(value.exit_code)));
        case 'media_delivery':
            return (isNonEmptyString(value.child_tool_call_id) &&
                (value.status === 'delivered' ||
                    value.status === 'unavailable' ||
                    value.status === 'budget_exceeded') &&
                (value.refs === undefined ||
                    (Array.isArray(value.refs) && value.refs.every(isPtcMediaReference))));
        case 'approval':
            return (isNonEmptyString(value.child_tool_call_id) &&
                (value.status === 'denied' || value.status === 'expired'));
        case 'plugin_feedback':
            return (isNonEmptyString(value.child_tool_call_id) &&
                (value.phase === 'additional_context' ||
                    value.phase === 'post_tool_feedback' ||
                    value.phase === 'updated_result') &&
                (value.text === undefined || typeof value.text === 'string'));
        case 'delivery_incomplete':
            return (value.reason === 'outer_limit' &&
                (value.reference === undefined || isNonEmptyString(value.reference)));
        case 'budget_exceeded':
            return ((value.budget === 'tool_calls' || value.budget === 'bridge' || value.budget === 'code') &&
                (value.refused_calls === undefined ||
                    (isSafeInteger(value.refused_calls) && value.refused_calls > 0)));
        default:
            return false;
    }
}
/** Longest tool error code kept; longer values are free text, not a code. */
const MAX_PTC_TOOL_ERROR_CODE_CHARS = 128;
/** Shared by the writer and the envelope reader so both accept the same codes. */
export function isPtcToolErrorCode(value) {
    return (typeof value === 'string' && value.length > 0 && value.length <= MAX_PTC_TOOL_ERROR_CODE_CHARS);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
}
function isSafeInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value);
}
function isPtcMediaReference(value) {
    return (isRecord(value) &&
        isNonEmptyString(value.uri) &&
        (value.mimeType === undefined || typeof value.mimeType === 'string'));
}
//# sourceMappingURL=ptc.js.map