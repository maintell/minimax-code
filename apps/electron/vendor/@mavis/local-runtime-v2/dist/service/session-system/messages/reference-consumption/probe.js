/**
 * Reference-consumption probe (read-only, pure).
 *
 * One question, answered from a turn's tool-call records: did the agent
 * actually read the messages of the session the user referenced?
 *
 * Why tool calls are the evidence: the Bunny prompt requires a turn that has
 * `run_code` to read history with `mavis_session_messages` *inside* run_code
 * (`assets/agents/bunny/system-prompt.md:81`), and other turns to use the
 * `mavis` tool's `session messages` command. A message-reading call in the
 * turn is therefore direct behavioural evidence, not a heuristic.
 *
 * Why this module owns its own tool-call reader instead of reusing the search
 * index's: `search-index/documents.ts:138` drops every call carrying
 * `parent_tool_call_id`, i.e. every PTC child call. That filter is correct for
 * the index (it keeps `task:<id>` document parts unique and keeps
 * `taskIdsOfCall` from being hijacked by a nested `assignment_*` child), but a
 * probe built on it would be blind to exactly the calls the prompt asks for —
 * a near-100% false-negative rate on run_code turns. The index filter is left
 * untouched; this reader is separate and never feeds the index.
 *
 * Three-state on purpose: `unknown` exists so "we could not tell" is never
 * recorded as "the agent did not read it".
 */
import { matchesTarget, observeReadCall } from './read-calls.js';
import { flattenToolCalls } from './tool-calls.js';
import { unique } from './values.js';
/**
 * Probe one turn's tool-call records.
 *
 * @param toolCalls The turn's tool calls: a display `ToolCall[]`, a
 *   `PtcToolCallRecord[]`, or the raw array as persisted on a message. PTC
 *   child calls are read whether they sit beside their parent in the array or
 *   are still nested in the parent's result.
 * @param target The referenced session / quoted message ids. Omit it (or pass
 *   an empty one) and the verdict is `unknown`.
 */
export function probeReferenceConsumption(toolCalls, target, options = {}) {
    const resolvedTarget = normalizeTarget(target);
    if (!resolvedTarget)
        return emptyReading('unknown', 'no_reference_target');
    if (!Array.isArray(toolCalls)) {
        return emptyReading('unknown', 'tool_calls_unavailable', resolvedTarget);
    }
    const readCalls = flattenToolCalls(toolCalls).flatMap((call) => observeReadCall(call, resolvedTarget, options));
    const matchingCalls = readCalls.filter((call) => matchesTarget(call, resolvedTarget));
    const requireMessageHit = options.requireMessageHit === true;
    const decision = decideVerdict(readCalls, matchingCalls, requireMessageHit);
    return {
        ...decision,
        target: resolvedTarget,
        readCalls,
        matchingCalls,
        matchedMessageIds: unique(matchingCalls.flatMap((call) => call.matchedMessageIds)),
        consumedViaPtcChild: effectiveCalls(matchingCalls, requireMessageHit).some((call) => call.fromPtcChild),
    };
}
/**
 * Probe straight from a persisted display message, reading `tool_calls` or the
 * legacy `toolCalls` field exactly as the rest of the message layer does.
 */
export function probeMessageReferenceConsumption(message, target, options = {}) {
    return probeReferenceConsumption(message?.tool_calls ?? message?.toolCalls, target, options);
}
/** Matching calls that actually prove the referenced content was read. */
function effectiveCalls(matchingCalls, requireMessageHit) {
    const succeeded = matchingCalls.filter((call) => call.outcome === 'succeeded');
    if (!requireMessageHit)
        return succeeded;
    return succeeded.filter((call) => call.matchedMessageIds.length > 0);
}
function decideVerdict(readCalls, matchingCalls, requireMessageHit) {
    const effective = effectiveCalls(matchingCalls, requireMessageHit);
    if (effective.length > 0) {
        const quoted = effective.some((call) => call.matchedMessageIds.length > 0);
        return {
            verdict: 'consumed',
            reason: quoted ? 'quoted_message_read' : 'referenced_session_read',
        };
    }
    const succeeded = matchingCalls.filter((call) => call.outcome === 'succeeded');
    if (requireMessageHit && succeeded.length > 0) {
        return { verdict: 'not_consumed', reason: 'quoted_message_not_in_read' };
    }
    if (matchingCalls.some((call) => call.outcome === 'incomplete')) {
        return { verdict: 'unknown', reason: 'read_call_incomplete' };
    }
    if (readCalls.some((call) => call.resolution === 'alias_unresolved')) {
        return { verdict: 'unknown', reason: 'read_call_unresolved' };
    }
    if (matchingCalls.some((call) => call.outcome === 'failed')) {
        return { verdict: 'not_consumed', reason: 'read_call_failed' };
    }
    if (readCalls.length === 0)
        return { verdict: 'not_consumed', reason: 'no_read_call' };
    return { verdict: 'not_consumed', reason: 'read_call_other_session' };
}
function emptyReading(verdict, reason, target = {}) {
    return {
        verdict,
        reason,
        target,
        readCalls: [],
        matchingCalls: [],
        matchedMessageIds: [],
        consumedViaPtcChild: false,
    };
}
function normalizeTarget(target) {
    if (!target)
        return undefined;
    const sessionId = typeof target.sessionId === 'string' ? target.sessionId.trim() : '';
    const messageIds = (target.messageIds ?? []).filter((id) => typeof id === 'string' && id.length > 0);
    if (!sessionId && messageIds.length === 0)
        return undefined;
    return {
        ...(sessionId ? { sessionId } : {}),
        ...(messageIds.length > 0 ? { messageIds } : {}),
    };
}
//# sourceMappingURL=probe.js.map