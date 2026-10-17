/**
 * Migration copy (MR1) of v1 `channels/message-format.ts`.
 */
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
        let icon = '…';
        if (tc.tool_call_status === ToolCallStatus.Finished)
            icon = '✓';
        else if (tc.tool_call_status === ToolCallStatus.Failed)
            icon = '✗';
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
        return (urlToolDetail(name, args) ??
            fileToolDetail(name, args) ??
            shellToolDetail(name, args) ??
            searchToolDetail(name, args) ??
            firstStringDetail(args) ??
            '');
    }
    catch {
        // malformed JSON
    }
    return '';
}
/** URL-based tools: show hostname (falls back to the raw value). */
function urlToolDetail(name, args) {
    if (!name.includes('fetch') && !name.includes('web') && !name.includes('browser'))
        return undefined;
    const url = (args.url ?? args.href ?? args.link);
    if (!url)
        return undefined;
    try {
        return new URL(url).hostname;
    }
    catch {
        return url.replace(/\n/g, ' ').trim();
    }
}
function fileToolDetail(name, args) {
    if (!name.includes('read') &&
        !name.includes('edit') &&
        !name.includes('write') &&
        !name.includes('glob') &&
        !name.includes('file'))
        return undefined;
    const filePath = (args.file_path ?? args.path ?? args.filePath);
    return filePath ? filePath.replace(/\n/g, ' ').trim() : undefined;
}
function shellToolDetail(name, args) {
    if (!name.includes('bash') &&
        !name.includes('shell') &&
        !name.includes('exec') &&
        !name.includes('command') &&
        !name.includes('terminal'))
        return undefined;
    const cmd = (args.command ?? args.cmd);
    return cmd ? cmd.replace(/\n/g, ' ').trim() : undefined;
}
function searchToolDetail(name, args) {
    if (!name.includes('grep') && !name.includes('search'))
        return undefined;
    const pattern = (args.pattern ?? args.query ?? args.search);
    return pattern ? pattern.replace(/\n/g, ' ').trim() : undefined;
}
/** Fallback: first non-empty string value. */
function firstStringDetail(args) {
    for (const val of Object.values(args)) {
        if (typeof val === 'string' && val.length > 0) {
            return val.replace(/\n/g, ' ').trim();
        }
    }
    return undefined;
}
//# sourceMappingURL=message-format.js.map