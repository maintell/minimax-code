/**
 * Tolerant tool-call normalisation for the reference-consumption probe.
 *
 * Deliberately NOT the search index's reader: `search-index/documents.ts:138`
 * drops every call carrying `parent_tool_call_id`, which is exactly the PTC
 * child call the Bunny prompt asks for. This reader keeps them.
 */
import { isRecord, parseJsonValue, readString } from './values.js';
/** Display `ToolCallStatus`: Start 1, Finished 2, Failed 3, Preparing 4, Prepared 5. */
const STATUS_FINISHED = 2;
const STATUS_FAILED = 3;
/** Bounds for the walks over tool payloads; results can carry whole histories. */
const MAX_WALK_DEPTH = 6;
const MAX_WALK_NODES = 20_000;
/**
 * Flatten a turn's records into top-level calls plus every PTC child call,
 * whether the child sits beside its parent or is still nested in the parent's
 * result (`details.ptc.child_calls`, `details.ptc_child.record`).
 */
export function flattenToolCalls(records) {
    const flattened = [];
    for (const record of records) {
        const call = normalizeCall(record, false);
        if (!call)
            continue;
        flattened.push(call);
        for (const child of nestedChildRecords(call.result)) {
            const normalized = normalizeCall(child, true);
            if (normalized)
                flattened.push(normalized);
        }
    }
    return flattened;
}
function normalizeCall(value, fromNestedChild) {
    const record = isRecord(value) ? value : undefined;
    if (!record)
        return undefined;
    const toolName = readString(record.tool_name) ?? readString(record.toolName);
    if (!toolName)
        return undefined;
    const parentToolCallId = readParentToolCallId(record);
    const toolCallId = readToolCallId(record);
    return {
        toolName,
        ...(toolCallId ? { toolCallId } : {}),
        ...(parentToolCallId ? { parentToolCallId } : {}),
        args: readCallArgs(record),
        result: readCallResult(record),
        outcome: readOutcome(record),
        fromPtcChild: fromNestedChild || Boolean(parentToolCallId),
    };
}
function readCallArgs(record) {
    return parseJsonValue(record.tool_call_args ?? record.toolCallArgs ?? record.input ?? record.args);
}
function readCallResult(record) {
    return parseJsonValue(record.tool_call_result_data ?? record.toolCallResultData ?? record.result);
}
function readToolCallId(record) {
    return (readString(record.tool_call_id) ??
        readString(record.toolCallId) ??
        readString(record.child_tool_call_id) ??
        readString(record.childToolCallId) ??
        readString(record.id));
}
function readParentToolCallId(record) {
    return readString(record.parent_tool_call_id) ?? readString(record.parentToolCallId);
}
function readOutcome(record) {
    const numeric = record.tool_call_status ?? record.toolCallStatus;
    if (typeof numeric === 'number')
        return outcomeOfNumericStatus(numeric);
    const textual = record.status;
    if (typeof textual === 'string')
        return outcomeOfTextualStatus(textual);
    // A record with no status at all still proves the call was issued.
    return 'succeeded';
}
function outcomeOfNumericStatus(status) {
    if (status === STATUS_FINISHED)
        return 'succeeded';
    if (status === STATUS_FAILED)
        return 'failed';
    return 'incomplete';
}
function outcomeOfTextualStatus(status) {
    if (status === 'completed')
        return 'succeeded';
    if (status === 'failed')
        return 'failed';
    if (status === 'unknown')
        return 'incomplete';
    return 'succeeded';
}
/** PTC child records still nested inside a parent result. */
function nestedChildRecords(result) {
    const found = [];
    walkForChildren(result, 0, { nodes: MAX_WALK_NODES }, found);
    return found;
}
function walkForChildren(value, depth, budget, found) {
    if (depth > MAX_WALK_DEPTH || budget.nodes <= 0)
        return;
    if (value === null || typeof value !== 'object')
        return;
    budget.nodes -= 1;
    if (Array.isArray(value)) {
        for (const item of value)
            walkForChildren(item, depth + 1, budget, found);
        return;
    }
    for (const [key, child] of Object.entries(value)) {
        const nested = childRecordsAt(key, child);
        if (nested) {
            found.push(...nested);
            continue;
        }
        walkForChildren(child, depth + 1, budget, found);
    }
}
/** Child records held directly under a known PTC key, if this entry is one. */
function childRecordsAt(key, value) {
    if ((key === 'child_calls' || key === 'childCalls') && Array.isArray(value))
        return value;
    if (key === 'ptc_child' && isRecord(value) && isRecord(value.record))
        return [value.record];
    return undefined;
}
//# sourceMappingURL=tool-calls.js.map