import { isNonAssistantScaffoldingPart, isToolCallPart, isToolResultPart, nativeToolResultMessage, readNativeDataRecord, readNativeDataText, } from './legacy-opencode-native-parts.js';
import { resolveApiForLegacyProvider } from './legacy-opencode-provider-api.js';
export { filterCompactedNativeMessages } from './legacy-opencode-native-compaction-filter.js';
/**
 * Bumped when the converter output shape changes in a way that older
 * migrated pi-history rows can no longer resume. Persisted on the migration
 * record alongside `piHistoryStrategy`; callers check
 * `isLegacyPiHistoryConverterCurrent` to decide whether an existing
 * `migrated` session must be re-migrated to pick up the fix.
 *
 * v1 (initial) emitted `{type: 'reasoning', text}`, `{type: 'tool-call',
 *   toolCallId, toolName, args}` and `role: 'tool'` — none of which the
 *   pi-agent runtime recognises, so tool calls silently disappeared from
 *   assistant messages and tool results never re-hydrated.
 * v2 aligns with `@earendil-works/pi-agent-core` types: `{type: 'thinking',
 *   thinking}`, `{type: 'toolCall', id, name, arguments}`, and
 *   `role: 'toolResult'` for the follow-up message. Opencode collapses
 *   tool call + result inside one `part` (`data.state.{input,output,error,
 *   status}`); v2 also splits it into the pair of records pi-agent expects.
 * v3 adds group-aware output (`PiHistoryGroup[]` instead of a flat
 *   `messages: PiAgentMessage[]`) so `buildPiHistory` can sort by
 *   opencode's atomic `message.time_created` (the leader timestamp)
 *   without ever slipping a follow-up user message between an assistant
 *   `toolCall` block and its paired `toolResult` when the tool took a
 *   long time to complete. v3 also emits opencode CompactionPart as a
 *   `kind='user'` group carrying "What did we do so far?" (mirrors
 *   opencode's `toModelMessages`) and, at the migrator level, truncates
 *   the source stream through `filterCompactedNativeMessages` so
 *   pre-compaction bulk is dropped instead of flooding pi-history.
 *   Records stamped with an older `piHistoryConverterVersion` are
 *   detected by `isLegacyPiHistoryConverterCurrent` and re-migrated.
 * v4 backfills the assistant `api` field. Opencode-native rows carry
 *   `providerID` + `modelID` but no `api` (opencode has no such concept),
 *   so v1-v3 emitted assistant messages with `api === undefined`. That
 *   undefined broke the outbound replay classifier
 *   (`normalizeAssistantMessage`): `sameProviderAndApi` compares
 *   `api === target.api`, so `undefined` forced every migrated thinking
 *   block down the cross-provider branch that wraps it in a
 *   `<|prior-thinking|>…</|prior-thinking|>` text marker — which the model
 *   then leaked into visible output after an upgrade. v4 derives `api`
 *   from the same source the live model resolver uses (pi-ai catalog +
 *   provider-family fallback, see `resolveApiForLegacyProvider`) so
 *   same-provider upgrades classify as same/sibling and keep native
 *   thinking replay. Records stamped `< 4` are re-migrated (or no-op
 *   stamped, if pi-agent already replaced the history) by the version
 *   upgrade path in the migrator.
 */
export const NATIVE_PI_HISTORY_CONVERTER_VERSION = 4;
/**
 * Convert native opencode `message` + `part` rows into pi-agent history
 * messages. The legacy schema interleaves user / assistant / tool entries
 * across the `role` column and JSON-encoded `part.data`; this routine
 * normalises them into pi-agent's role-based shape while accounting for
 * the lossy bits we can no longer resume (interrupted tool runs, dropped
 * empty messages, unknown roles).
 */
export function convertNativeMessagesToPiHistory(messages, nowMs, resolveApi = resolveApiForLegacyProvider) {
    const groups = [];
    const warnings = [];
    const losses = {
        emptyMessages: 0,
        unknownRoles: 0,
        unsupportedParts: 0,
        interruptedTools: 0,
        parseLoss: 0,
    };
    const counts = {
        source: { userMessages: 0, assistantMessages: 0, toolCall: 0, reasoning: 0, text: 0 },
        converted: {
            userMessages: 0,
            assistantMessages: 0,
            toolResultMessages: 0,
            toolCall: 0,
            thinking: 0,
            text: 0,
        },
    };
    // Source-side scan: count opencode part types before any conversion decision.
    countNativeSourceMessages(messages, counts);
    for (const message of messages) {
        const role = normalizeNativeRole(message.role, message.parts);
        const timestamp = message.timestamp ?? firstPartTimestamp(message.parts) ?? nowMs();
        convertNativeMessage(message, role, timestamp, {
            resolveApi,
            state: { groups, losses, counts },
        });
    }
    for (const [key, count] of Object.entries(losses)) {
        if (count > 0)
            warnings.push(`legacy_native_${kebabCase(key)}:${count}`);
    }
    // Semantic-loss warnings the quality gate can hard-fail on. Kept as
    // structured warning strings so migration-record UI keeps rendering
    // them without special-casing.
    if (counts.source.toolCall > 0 && counts.converted.toolCall === 0) {
        warnings.push(`legacy_native_tool_call_dropped:${counts.source.toolCall}`);
    }
    else if (counts.source.toolCall > 0 && counts.converted.toolCall < counts.source.toolCall) {
        warnings.push(`legacy_native_tool_call_partial:${counts.converted.toolCall}/${counts.source.toolCall}`);
    }
    return { groups, warnings, losses, counts, degraded: warnings.length > 0 };
}
function countNativeSourceMessages(messages, counts) {
    for (const message of messages) {
        const role = normalizeNativeRole(message.role, message.parts);
        if (role === 'user')
            counts.source.userMessages += 1;
        if (role === 'assistant')
            counts.source.assistantMessages += 1;
        for (const part of message.parts)
            countNativeSourcePart(part, counts);
    }
}
function countNativeSourcePart(part, counts) {
    const type = part.type.toLowerCase();
    if (type === 'text' || type === 'message' || type === 'assistant_text')
        counts.source.text += 1;
    else if (type === 'reasoning' || type === 'thinking')
        counts.source.reasoning += 1;
    else if (isToolCallPart(part))
        counts.source.toolCall += 1;
}
function convertNativeMessage(message, role, timestamp, input) {
    if (role === 'user')
        return convertNativeUserMessage(message, timestamp, input.state);
    if (role === 'assistant')
        return convertNativeAssistantMessage(message, timestamp, input.resolveApi, input.state);
    if (role === 'tool')
        return convertNativeToolMessage(message, timestamp, input.state);
    input.state.losses.unknownRoles += 1;
}
function convertNativeUserMessage(message, timestamp, state) {
    const text = hasCompactionPart(message.parts)
        ? 'What did we do so far?'
        : collectNativeText(message.parts);
    if (!text.trim()) {
        state.losses.emptyMessages += 1;
        return;
    }
    state.groups.push({
        leaderTimestamp: timestamp,
        kind: 'user',
        sourceMessageId: message.id,
        messages: [{ role: 'user', content: [{ type: 'text', text }], timestamp }],
    });
    state.counts.converted.userMessages += 1;
    state.counts.converted.text += 1;
}
function convertNativeAssistantMessage(message, timestamp, resolveApi, state) {
    const content = buildAssistantContentBlocks(message.parts, state.losses);
    if (content.length === 0) {
        state.losses.emptyMessages += 1;
        return;
    }
    const assistantMessage = createAssistantMessage(message, content, timestamp, resolveApi);
    state.counts.converted.assistantMessages += 1;
    countAssistantBlocks(content, state.counts);
    const groupMessages = [assistantMessage];
    for (const part of message.parts) {
        const toolResult = nativeToolResultMessage(part, timestamp, state.losses);
        if (!toolResult)
            continue;
        groupMessages.push(toolResult);
        state.counts.converted.toolResultMessages += 1;
    }
    state.groups.push({
        leaderTimestamp: timestamp,
        kind: 'assistant',
        sourceMessageId: message.id,
        messages: groupMessages,
    });
}
function createAssistantMessage(message, content, timestamp, resolveApi) {
    const resolvedApi = message.api ?? (message.provider ? resolveApi(message.provider, message.model) : undefined);
    return {
        role: 'assistant',
        content,
        ...(message.model ? { model: message.model } : {}),
        ...(message.provider ? { provider: message.provider } : {}),
        ...(resolvedApi ? { api: resolvedApi } : {}),
        timestamp,
    };
}
function countAssistantBlocks(content, counts) {
    for (const block of content) {
        const type = typeof block['type'] === 'string' ? block['type'] : '';
        if (type === 'text')
            counts.converted.text += 1;
        if (type === 'thinking')
            counts.converted.thinking += 1;
        if (type === 'toolCall')
            counts.converted.toolCall += 1;
    }
}
function convertNativeToolMessage(message, timestamp, state) {
    for (const part of message.parts) {
        const toolResult = nativeToolResultMessage(part, timestamp, state.losses);
        if (!toolResult)
            continue;
        state.groups.push({
            leaderTimestamp: timestamp,
            kind: 'tool',
            sourceMessageId: message.id,
            messages: [toolResult],
        });
        state.counts.converted.toolResultMessages += 1;
    }
}
function normalizeNativeRole(role, parts) {
    const normalized = role?.trim().toLowerCase();
    if (normalized === 'user')
        return 'user';
    if (normalized === 'assistant')
        return 'assistant';
    if (normalized === 'tool')
        return 'tool';
    if (parts.some(isToolResultPart))
        return 'tool';
    if (parts.some(isToolCallPart))
        return 'assistant';
    return normalized ? undefined : 'assistant';
}
function collectNativeText(parts) {
    return parts
        .flatMap((part) => {
        if (part.text)
            return [part.text];
        const dataText = readNativeDataText(part.data, ['text', 'content', 'summary']);
        return dataText ? [dataText] : [];
    })
        .join('\n');
}
function buildAssistantContentBlocks(parts, losses) {
    const blocks = [];
    for (const part of parts) {
        const block = assistantContentBlock(part, blocks.length, losses);
        if (block)
            blocks.push(block);
    }
    return blocks;
}
function assistantContentBlock(part, index, losses) {
    const type = part.type.toLowerCase();
    if (type === 'text' || type === 'message' || type === 'assistant_text') {
        return textContentBlock(part);
    }
    if (type === 'reasoning' || type === 'thinking')
        return thinkingContentBlock(part);
    if (isToolCallPart(part))
        return toolCallContentBlock(part, index);
    if (isToolResultPart(part) || isNonAssistantScaffoldingPart(type))
        return undefined;
    losses.unsupportedParts += 1;
    return undefined;
}
function textContentBlock(part) {
    const text = part.text ?? readNativeDataText(part.data, ['text', 'content']);
    return text ? { type: 'text', text } : undefined;
}
function thinkingContentBlock(part) {
    const thinking = part.text ?? readNativeDataText(part.data, ['text', 'content', 'thinking']);
    return thinking ? { type: 'thinking', thinking } : undefined;
}
function toolCallContentBlock(part, index) {
    const args = readNativeDataRecord(part.state, ['input']) ??
        readNativeDataRecord(part.data, ['args', 'input', 'parameters']) ??
        objectData(part.data) ??
        {};
    return {
        type: 'toolCall',
        id: part.toolCallId ?? part.id ?? `legacy-tool-${index + 1}`,
        name: part.toolName ??
            readNativeDataText(part.data, ['toolName', 'tool_name', 'name', 'tool']) ??
            'unknown',
        arguments: args,
    };
}
function objectData(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function firstPartTimestamp(parts) {
    return parts.find((part) => typeof part.timestamp === 'number')?.timestamp;
}
/**
 * True when any part inside this opencode message is a `compaction` part
 * (opencode summarisation marker). Used by
 * `convertNativeMessagesToPiHistory` to translate the compaction marker
 * into a `{role:'user', text:'What did we do so far?'}` message —
 * mirrors opencode's own `toModelMessages` behaviour so pi-agent replays
 * the same conversational shape opencode does after a compaction.
 */
function hasCompactionPart(parts) {
    return parts.some((part) => part.type.toLowerCase() === 'compaction');
}
function kebabCase(value) {
    return value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}
//# sourceMappingURL=legacy-opencode-native-conversion.js.map