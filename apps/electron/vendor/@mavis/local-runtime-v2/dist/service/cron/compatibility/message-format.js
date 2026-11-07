/**
 * Pure outbound formatters for the IM channel reply — the §4.2 "附加工具调用"
 * (tool-call summary) and §4.3 "精简输出" (result-mode fallback) logic.
 *
 * Ported from `main`'s
 * `packages/daemon/src/channel-bridge/plugin-runner-utils.ts` (the §4.2/§4.3
 * formatters only — `splitIntoChunks` is intentionally NOT ported). These are
 * pure functions with no daemon/runner state dependency.
 *
 * The ONLY adaptation vs main is the import source. main imports its `ToolCall`
 * type + `ToolCallStatus` enum from `../common/agent-protocol.js`; on this
 * branch the channel collector operates on `RespData` frames whose `tool_calls`
 * are typed as `ToolCall` from `@mavis/agent-core/protocol/agent-message`. That
 * shape is identical (same fields, same `ToolCallStatus.Finished` / `.Failed`
 * casing — `ToolCallStatus` is a const object `{ Start:1, Finished:2,
 * Failed:3 }` there), so the body is byte-for-byte.
 *
 * Kept in a separate file so `local-channel-runner.ts` stays under the
 * 2000-line source-file size cap.
 */
import { parseMediaTags, placeholderMediaTags } from '@mavis/shared';
import { ToolCallStatus } from '@mavis/agent-core/protocol/agent-message';
const STRUCTURED_TAG_START_RE = /<(media|genui|deliver-assets)\b[^>]*(?:>|$)/giu;
function toolStatusIcon(status) {
    if (status === ToolCallStatus.Finished)
        return '✓';
    if (status === ToolCallStatus.Failed)
        return '✗';
    return '…';
}
const TOOL_DETAIL_FIELDS = [
    { names: ['fetch', 'web', 'browser'], fields: ['url', 'href', 'link'], url: true },
    { names: ['read', 'edit', 'write', 'glob', 'file'], fields: ['file_path', 'path', 'filePath'] },
    { names: ['bash', 'shell', 'exec', 'command', 'terminal'], fields: ['command', 'cmd'] },
    { names: ['grep', 'search'], fields: ['pattern', 'query', 'search'] },
];
/**
 * run_code's first argument is the program source, so the generic first-string
 * fallback would print JavaScript into the IM reply. Show the model's one-line
 * description instead, or nothing; the children it ran are listed on their own.
 */
function programToolDetail(name, args) {
    if (name !== 'run_code')
        return undefined;
    const description = args.description;
    return typeof description === 'string' ? description.replace(/\n/g, ' ').trim() : '';
}
function extractKnownToolDetail(name, args) {
    for (const detail of TOOL_DETAIL_FIELDS) {
        if (!detail.names.some((part) => name.includes(part)))
            continue;
        const value = detail.fields.map((field) => args[field]).find((item) => item != null);
        if (!value)
            continue;
        const text = value;
        if (detail.url)
            return toolUrlDetail(text);
        return text.replace(/\n/g, ' ').trim();
    }
    return undefined;
}
function toolUrlDetail(url) {
    try {
        return new URL(url).hostname;
    }
    catch {
        return url.replace(/\n/g, ' ').trim();
    }
}
/**
 * Format tool calls into a readable summary.
 *
 * Output:
 *   🔧 工具调用
 *   - webfetch → boxofficecn.com ✓
 *   - read → src/index.ts ✓
 */
export function formatToolSummary(toolCalls) {
    const lines = ['🔧 工具调用'];
    for (const tc of toolCalls.values()) {
        const icon = toolStatusIcon(tc.tool_call_status);
        const detail = extractToolDetail(tc.tool_name, tc.tool_call_args);
        const label = detail ? `${tc.tool_name} → ${detail}` : tc.tool_name;
        lines.push(`- ${label} ${icon}`);
    }
    return lines.join('\n');
}
/**
 * True when a tool call is an interactive-flow tool that delivers its UI
 * out-of-band and terminates the turn (e.g. `ask_user` questionnaire). Such a
 * tool's result is a control payload ("waiting for the user…", `terminate:true`)
 * — NOT user-facing content — so it must never be surfaced by the result-mode
 * fallback. The question/prompt is already delivered via the dedicated
 * card/text path; turn-1 should stay silent on IM for these tools.
 *
 * Detected by tool name (`ask_user`, primary/cheap) OR by parsing the result
 * payload for the `terminate` / `details.waiting_for_user` markers (safety net
 * for any future interactive tool). `ToolCall.tool_call_result_data` is a JSON
 * STRING, so the markers are read by parsing it; malformed/absent → not skipped.
 */
function isInteractiveTerminateTool(tc) {
    if (tc.tool_name === 'ask_user')
        return true;
    const raw = tc.tool_call_result_data;
    if (!raw)
        return false;
    try {
        const obj = JSON.parse(raw);
        if (obj.terminate === true)
            return true;
        const details = obj.details;
        if (details && details.waiting_for_user === true)
            return true;
    }
    catch {
        // not JSON / not an interactive payload — fall through.
    }
    return false;
}
/**
 * Build result-mode fallback from finished tool outputs.
 * Used when no assistant text is emitted but tools returned data.
 */
export function formatToolResultFallback(toolCalls) {
    const lines = [];
    for (const tc of toolCalls.values()) {
        if (isInteractiveTerminateTool(tc))
            continue;
        if (tc.tool_call_status !== ToolCallStatus.Finished)
            continue;
        const raw = (tc.tool_call_result_data ?? '').trim();
        if (!raw)
            continue;
        const detail = extractToolDetail(tc.tool_name, tc.tool_call_args);
        const label = detail ? `${tc.tool_name} → ${detail}` : tc.tool_name;
        lines.push(`🔧 ${label}\n${sanitizeChannelReplyText(raw)}`);
    }
    return lines.join('\n\n').trim();
}
export function sanitizeChannelReplyText(text) {
    const parsed = parseMediaTags(text);
    return stripRawStructuredTags(placeholderMediaTags(parsed.text)).trim();
}
function stripRawStructuredTags(text) {
    let output = '';
    let cursor = 0;
    STRUCTURED_TAG_START_RE.lastIndex = 0;
    for (;;) {
        const match = STRUCTURED_TAG_START_RE.exec(text);
        if (!match)
            break;
        const tagName = match[1]?.toLowerCase();
        if (!tagName)
            break;
        output += text.slice(cursor, match.index);
        if (match[0].endsWith('/>')) {
            cursor = STRUCTURED_TAG_START_RE.lastIndex;
            continue;
        }
        const closeRe = new RegExp(`</${tagName}>`, 'iu');
        const rest = text.slice(STRUCTURED_TAG_START_RE.lastIndex);
        const close = closeRe.exec(rest);
        if (!close) {
            cursor = text.length;
            break;
        }
        cursor = STRUCTURED_TAG_START_RE.lastIndex + close.index + close[0].length;
        STRUCTURED_TAG_START_RE.lastIndex = cursor;
    }
    return output + text.slice(cursor);
}
/**
 * Extract a human-readable detail from tool call args JSON.
 * Returns hostname for URL tools, file path for file tools, etc.
 */
export function extractToolDetail(toolName, argsJson) {
    if (!argsJson)
        return '';
    try {
        const args = JSON.parse(argsJson);
        const name = toolName.toLowerCase();
        const programDetail = programToolDetail(name, args);
        if (programDetail !== undefined)
            return programDetail;
        const knownDetail = extractKnownToolDetail(name, args);
        if (knownDetail !== undefined)
            return knownDetail;
        // Fallback: first short string value
        for (const val of Object.values(args)) {
            if (typeof val === 'string' && val.length > 0) {
                return val.replace(/\n/g, ' ').trim();
            }
        }
    }
    catch {
        // malformed JSON
    }
    return '';
}
//# sourceMappingURL=message-format.js.map