import { isNonAssistantScaffoldingPart, isToolCallPart, isToolResultPart, nativeToolResultMessage, readNativeDataRecord, readNativeDataText, } from './legacy-opencode-native-parts.js';
import { resolveApiForLegacyProvider } from './legacy-opencode-provider-api.js';
export { filterCompactedNativeMessages, } from './legacy-opencode-native-compaction-filter.js';
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
    // Source-side scan: count opencode part types before any conversion
    // decision. Used by the quality-gate in the migrator to catch shape
    // regressions where source.toolCall > 0 but converted.toolCall == 0.
    for (const message of messages) {
        const role = normalizeNativeRole(message.role, message.parts);
        if (role === 'user')
            counts.source.userMessages += 1;
        else if (role === 'assistant')
            counts.source.assistantMessages += 1;
        for (const part of message.parts) {
            const type = part.type.toLowerCase();
            if (type === 'text' || type === 'message' || type === 'assistant_text') {
                counts.source.text += 1;
            }
            else if (type === 'reasoning' || type === 'thinking') {
                counts.source.reasoning += 1;
            }
            else if (isToolCallPart(part)) {
                counts.source.toolCall += 1;
            }
        }
    }
    for (const message of messages) {
        const role = normalizeNativeRole(message.role, message.parts);
        const timestamp = message.timestamp ?? firstPartTimestamp(message.parts) ?? nowMs();
        // Opencode CompactionPart lives inside a `role: 'user'` message
        // alongside plain text parts. Mirror opencode `toModelMessages` and
        // emit a user text message ("What did we do so far?") — the summary
        // assistant that follows this compaction message will fall through
        // the regular assistant branch below.
        if (role === 'user' && hasCompactionPart(message.parts)) {
            groups.push({
                leaderTimestamp: timestamp,
                kind: 'user',
                sourceMessageId: message.id,
                messages: [
                    {
                        role: 'user',
                        content: [{ type: 'text', text: 'What did we do so far?' }],
                        timestamp,
                    },
                ],
            });
            counts.converted.userMessages += 1;
            counts.converted.text += 1;
            continue;
        }
        if (role === 'user') {
            const text = collectNativeText(message.parts);
            if (!text.trim()) {
                losses.emptyMessages += 1;
                continue;
            }
            groups.push({
                leaderTimestamp: timestamp,
                kind: 'user',
                sourceMessageId: message.id,
                messages: [
                    { role: 'user', content: [{ type: 'text', text }], timestamp },
                ],
            });
            counts.converted.userMessages += 1;
            counts.converted.text += 1;
            continue;
        }
        if (role === 'assistant') {
            const content = buildAssistantContentBlocks(message.parts, losses);
            if (content.length === 0) {
                losses.emptyMessages += 1;
                continue;
            }
            // Backfill `api` (v4): opencode rows never carry it, so prefer the
            // source value when present, otherwise derive it from the provider
            // (+model) via the resolver. Without a resolvable api the outbound
            // classifier treats every thinking block as cross-provider and leaks
            // `<|prior-thinking|>` markers after an upgrade.
            const resolvedApi = message.api ?? (message.provider ? resolveApi(message.provider, message.model) : undefined);
            const assistantMessage = {
                role: 'assistant',
                content,
                timestamp,
                ...(message.model ? { model: message.model } : {}),
                ...(message.provider ? { provider: message.provider } : {}),
                ...(resolvedApi ? { api: resolvedApi } : {}),
            };
            counts.converted.assistantMessages += 1;
            for (const block of content) {
                const blockType = typeof block['type'] === 'string' ? block['type'] : '';
                if (blockType === 'text')
                    counts.converted.text += 1;
                else if (blockType === 'thinking')
                    counts.converted.thinking += 1;
                else if (blockType === 'toolCall')
                    counts.converted.toolCall += 1;
            }
            // Assistant messages in opencode collapse tool-call + tool-result into
            // one `type: 'tool'` part (see `readNativeToolState` in the store).
            // pi-agent expects the call as a content block on the assistant + a
            // separate `role: 'toolResult'` message immediately after — both live
            // in the same PiHistoryGroup so the group-aware merge in
            // `buildPiHistory` keeps them adjacent regardless of when the tool
            // actually finished.
            const groupMessages = [assistantMessage];
            for (const part of message.parts) {
                const toolResult = nativeToolResultMessage(part, timestamp, losses);
                if (toolResult) {
                    groupMessages.push(toolResult);
                    counts.converted.toolResultMessages += 1;
                }
            }
            groups.push({
                leaderTimestamp: timestamp,
                kind: 'assistant',
                sourceMessageId: message.id,
                messages: groupMessages,
            });
            continue;
        }
        if (role === 'tool') {
            // Rare — opencode usually folds tool parts onto the previous
            // assistant message. If it happens standalone, emit each
            // toolResult as its own single-row group.
            for (const part of message.parts) {
                const toolResult = nativeToolResultMessage(part, timestamp, losses);
                if (toolResult) {
                    groups.push({
                        leaderTimestamp: timestamp,
                        kind: 'tool',
                        sourceMessageId: message.id,
                        messages: [toolResult],
                    });
                    counts.converted.toolResultMessages += 1;
                }
            }
            continue;
        }
        losses.unknownRoles += 1;
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
        const type = part.type.toLowerCase();
        if (type === 'text' || type === 'message' || type === 'assistant_text') {
            const text = part.text ?? readNativeDataText(part.data, ['text', 'content']);
            if (text)
                blocks.push({ type: 'text', text });
            continue;
        }
        if (type === 'reasoning' || type === 'thinking') {
            const thinking = part.text ?? readNativeDataText(part.data, ['text', 'content', 'thinking']);
            if (thinking)
                blocks.push({ type: 'thinking', thinking });
            continue;
        }
        if (isToolCallPart(part)) {
            // Args on opencode: `state.input`. Older/other shapes fall through
            // `args` / `parameters` / raw data payload. `{}` is the pi-agent
            // ToolCall default (Record<string, any>) — matches
            // `@earendil-works/pi-agent-core`'s ToolCall schema.
            const args = readNativeDataRecord(part.state, ['input']) ??
                readNativeDataRecord(part.data, ['args', 'input', 'parameters']) ??
                (part.data && typeof part.data === 'object' && !Array.isArray(part.data)
                    ? part.data
                    : undefined) ??
                {};
            blocks.push({
                type: 'toolCall',
                id: part.toolCallId ?? part.id ?? `legacy-tool-${blocks.length + 1}`,
                name: part.toolName ??
                    readNativeDataText(part.data, ['toolName', 'tool_name', 'name', 'tool']) ??
                    'unknown',
                arguments: args,
            });
            continue;
        }
        if (isToolResultPart(part))
            continue;
        // step-start / step-finish / snapshot / patch / compaction / file etc.
        // are opencode's internal event bookkeeping and don't map onto a
        // pi-agent content block.
        if (isNonAssistantScaffoldingPart(type))
            continue;
        losses.unsupportedParts += 1;
    }
    return blocks;
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