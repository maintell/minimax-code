/**
 * Enforce the Messages-compatible tool_use / tool_result contract on a legacy
 * migration segment. See the module doc for the rule catalogue.
 */
export function sanitizePiHistoryForMessages(messages, options = {}) {
    const stats = {
        orphanToolCallDropped: 0,
        orphanToolResultDropped: 0,
        reorderedPairDropped: 0,
        emptyAssistantDropped: 0,
        inspected: messages.length,
    };
    const warnings = [];
    const tagSuffix = options.tag ? `:${options.tag}` : '';
    const out = [];
    let inFlight;
    const finaliseInFlight = () => {
        if (!inFlight)
            return;
        // Any toolCall id still pending is an orphan (R1) — remove those
        // blocks from the assistant. If the assistant is left with zero
        // content, drop it entirely (R4).
        if (inFlight.pendingIds.size > 0) {
            const assistant = out[inFlight.outIndex];
            if (assistant && assistantHasBlocks(assistant)) {
                const filtered = filterToolCallBlocks(assistant, inFlight.pendingIds);
                for (const id of inFlight.pendingIds) {
                    const droppedName = readToolNameFromAssistant(assistant, id);
                    warnings.push(`sanitizer_dropped_orphan_tool_call:${id}:${droppedName}${tagSuffix}`);
                    stats.orphanToolCallDropped += 1;
                }
                if (isAssistantContentEmpty(filtered)) {
                    warnings.push(`sanitizer_dropped_empty_assistant:1${tagSuffix}`);
                    stats.emptyAssistantDropped += 1;
                    out.splice(inFlight.outIndex, 1);
                }
                else {
                    out[inFlight.outIndex] = filtered;
                }
            }
        }
        inFlight = undefined;
    };
    for (const raw of messages) {
        const role = readRole(raw);
        if (role === 'toolResult') {
            const toolCallId = readToolCallId(raw);
            const toolName = readToolName(raw);
            if (inFlight && toolCallId && inFlight.pendingIds.has(toolCallId)) {
                // Legal pairing — emit the result and remove from the pending
                // set. Keep `inFlight` open in case more toolResults for the
                // same assistant follow (opencode assistants routinely carry
                // multiple tool calls, so multiple toolResults can chain).
                inFlight.pendingIds.delete(toolCallId);
                inFlight.seenAtLeastOneResult = true;
                out.push(raw);
                if (inFlight.pendingIds.size === 0) {
                    // All expected results seen — assistant is fully paired.
                    inFlight = undefined;
                }
                continue;
            }
            if (inFlight && toolCallId && inFlight.dropReorderedForIds.has(toolCallId)) {
                // The toolCall for this id was already dropped as R3 — swallow
                // the stranded result too so we don't leak an orphan tool_result
                // (R2 semantically, tracked under R3 for observability).
                inFlight.dropReorderedForIds.delete(toolCallId);
                warnings.push(`sanitizer_dropped_reordered_tool_pair:${toolCallId}:${toolName}${tagSuffix}`);
                stats.reorderedPairDropped += 1;
                continue;
            }
            // Orphan toolResult (no matching toolCall in the immediate
            // in-flight assistant).
            warnings.push(`sanitizer_dropped_orphan_tool_result:${toolCallId ?? 'unknown'}:${toolName}${tagSuffix}`);
            stats.orphanToolResultDropped += 1;
            continue;
        }
        // Non-toolResult message breaks the in-flight assistant's pairing
        // window. Any still-pending toolCall becomes R3 (was going to be
        // paired but user/assistant interrupted). Anything that survived
        // (fully-paired assistants) stays in `out` untouched.
        //
        // NOTE: we intentionally KEEP `inFlight` alive after this branch —
        // it now holds only `dropReorderedForIds` so a stranded toolResult
        // arriving later this turn gets swallowed cleanly (counted under
        // R3, not R2). The next message emitted by the caller decides
        // whether we're truly done with this assistant: either a stranded
        // toolResult (dropReorderedForIds hit above) or a fresh assistant /
        // user message that just walks past.
        if (inFlight && inFlight.pendingIds.size > 0) {
            const assistant = out[inFlight.outIndex];
            if (assistant && assistantHasBlocks(assistant)) {
                // Rule choice: R5 (partial-match orphan, some calls were
                // paired) vs R3 (reordered pair, nothing was paired). Both
                // strip the toolCall blocks the same way; the difference is
                // ONLY in classification / observability.
                const useOrphanRule = inFlight.seenAtLeastOneResult;
                for (const id of inFlight.pendingIds) {
                    const droppedName = readToolNameFromAssistant(assistant, id);
                    if (useOrphanRule) {
                        warnings.push(`sanitizer_dropped_orphan_tool_call:${id}:${droppedName}${tagSuffix}`);
                        stats.orphanToolCallDropped += 1;
                    }
                    else {
                        warnings.push(`sanitizer_dropped_reordered_tool_pair:${id}:${droppedName}${tagSuffix}`);
                        stats.reorderedPairDropped += 1;
                    }
                }
                // Drop the reordered / orphan toolCall blocks; keep any
                // remaining content. The stranded toolResults arriving later
                // are recognised via `dropReorderedForIds` and swallowed too
                // (R3-classified — the tool_result that never gets matched
                // is a reordered leftover, not an independent orphan).
                const filtered = filterToolCallBlocks(assistant, inFlight.pendingIds);
                const droppedIds = new Set(inFlight.pendingIds);
                let outIndex = inFlight.outIndex;
                if (isAssistantContentEmpty(filtered)) {
                    warnings.push(`sanitizer_dropped_empty_assistant:1${tagSuffix}`);
                    stats.emptyAssistantDropped += 1;
                    out.splice(inFlight.outIndex, 1);
                    outIndex = -1; // assistant is gone, nothing to reference
                }
                else {
                    out[inFlight.outIndex] = filtered;
                }
                inFlight = {
                    outIndex,
                    pendingIds: new Set(),
                    dropReorderedForIds: new Set([...inFlight.dropReorderedForIds, ...droppedIds]),
                    seenAtLeastOneResult: inFlight.seenAtLeastOneResult,
                };
            }
            else {
                inFlight = undefined;
            }
        }
        if (role === 'assistant') {
            const assistant = raw;
            if (!assistantHasBlocks(assistant) || isAssistantContentEmpty(assistant)) {
                // R4 — natural empty assistant, drop.
                warnings.push(`sanitizer_dropped_empty_assistant:1${tagSuffix}`);
                stats.emptyAssistantDropped += 1;
                continue;
            }
            const toolCallIds = readAssistantToolCallIds(assistant);
            out.push(assistant);
            if (toolCallIds.length === 0)
                continue;
            inFlight = {
                outIndex: out.length - 1,
                pendingIds: new Set(toolCallIds),
                dropReorderedForIds: new Set(),
                seenAtLeastOneResult: false,
            };
            continue;
        }
        // User (or any other non-tool role) — just emit.
        out.push(raw);
    }
    // End of stream: any assistant still in flight has orphan toolCalls
    // (R1). This branch fires for legacy segments whose LAST assistant
    // never got a toolResult (interrupted tool at import time). Callers
    // that also merge a continuation stream should NOT rely on this
    // branch to bail them out — this helper only sees the segment
    // they hand in. Even so, running R1 here keeps the OUTPUT of
    // sanitize() legal in isolation (useful for tests + defence in
    // depth).
    finaliseInFlight();
    return { messages: out, warnings, stats };
}
function readRole(message) {
    const value = message.role;
    return typeof value === 'string' ? value : undefined;
}
function readToolCallId(message) {
    const value = message.toolCallId;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function readToolName(message) {
    const value = message.toolName;
    return typeof value === 'string' && value.length > 0 ? value : 'unknown';
}
function assistantHasBlocks(message) {
    const content = message.content;
    return Array.isArray(content);
}
function isAssistantContentEmpty(message) {
    const content = message.content;
    return !Array.isArray(content) || content.length === 0;
}
function readAssistantToolCallIds(message) {
    const content = message.content;
    if (!Array.isArray(content))
        return [];
    const ids = [];
    for (const block of content) {
        if (block &&
            typeof block === 'object' &&
            block.type === 'toolCall' &&
            typeof block.id === 'string' &&
            block.id.length > 0) {
            ids.push(block.id);
        }
    }
    return ids;
}
function readToolNameFromAssistant(message, toolCallId) {
    const content = message.content;
    if (!Array.isArray(content))
        return 'unknown';
    for (const block of content) {
        if (block &&
            typeof block === 'object' &&
            block.type === 'toolCall' &&
            block.id === toolCallId &&
            typeof block.name === 'string' &&
            block.name.length > 0) {
            return block.name;
        }
    }
    return 'unknown';
}
function filterToolCallBlocks(message, toolCallIds) {
    const content = message.content;
    if (!Array.isArray(content))
        return message;
    const filtered = content.filter((block) => {
        if (!block || typeof block !== 'object' || block.type !== 'toolCall')
            return true;
        if (typeof block.id !== 'string')
            return true;
        return !toolCallIds.has(block.id);
    });
    return {
        ...message,
        content: filtered,
    };
}
//# sourceMappingURL=pi-history-sanitizer.js.map