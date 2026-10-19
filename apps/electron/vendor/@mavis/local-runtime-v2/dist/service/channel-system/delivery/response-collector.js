/**
 * Committed-message reply collection for channel outbound.
 *
 * Migration copy (MR1): the committed-messages half of v1
 * `channels/sse-collector.ts`. The SSE half (`collectChannelResponseFromSse`
 * and its frame decoding) is intentionally NOT migrated — the proposal marks
 * the legacy SSE execution path as delete-with-v1 (MR3); the v2 runner only
 * collects from `RuntimeConversation` committed display messages.
 */
import { ToolCallStatus } from '@mavis/agent-core/protocol/agent-message';
import { parseMediaTags } from '@mavis/shared';
import { extractToolDetail, formatToolResultFallback, formatToolSummary, sanitizeChannelReplyText, } from './message-format.js';
/**
 * Default filter when none is supplied — equals legacy behavior (concise
 * `result` mode, no tool-call summary). Kept as a const so every "is this the
 * default?" check stays in sync with the omitted-filter contract.
 */
const DEFAULT_MESSAGE_FILTER = {
    mode: 'result',
    includeToolSummary: false,
};
/** Builds the same Channel reply projection from committed display-message DTOs. */
export function collectChannelResponseFromMessages(messages, filter, error) {
    const f = filter ?? DEFAULT_MESSAGE_FILTER;
    const collector = new CommittedMessageCollector(f);
    messages.forEach((message) => collector.take(message));
    return collector.finish(error);
}
/**
 * Stateful fold over the committed messages, extracted from the v1 inline
 * closure so each step stays inside the complexity budget. Semantics are
 * v1-identical: result mode keeps only the text after the last tool call
 * (with a tool fallback when the text is empty), full mode inlines 🔧
 * markers and thinking.
 */
class CommittedMessageCollector {
    filter;
    body = '';
    seenToolCall = false;
    finalMessages = 0;
    toolCalls = new Map();
    constructor(filter) {
        this.filter = filter;
    }
    take(message) {
        if (message.role === 'user' || message.role === 'system' || message.kind === 'compaction') {
            return;
        }
        this.finalMessages += 1;
        message.toolCalls?.forEach((toolCall) => this.takeToolCall(toolCall));
        if (message.toolCalls && message.toolCalls.length > 0 && this.filter.mode === 'result') {
            this.seenToolCall = true;
        }
        this.takeText(message);
        if (message.thinking && this.filter.mode === 'full')
            this.body += message.thinking;
    }
    takeText(message) {
        if (!message.text)
            return;
        if (this.filter.mode === 'result' && this.seenToolCall) {
            // Result mode: text after a tool call replaces the pre-tool text.
            this.body = '';
            this.seenToolCall = false;
        }
        this.body += message.text;
    }
    takeToolCall(toolCall) {
        const previous = this.toolCalls.get(toolCall.tool_call_id);
        const mergedArgs = toolCall.tool_call_args || previous?.tool_call_args;
        this.toolCalls.set(toolCall.tool_call_id, { ...toolCall, tool_call_args: mergedArgs });
        if (this.filter.mode === 'full' && toolCall.tool_call_status !== ToolCallStatus.Finished) {
            const detail = extractToolDetail(toolCall.tool_name, mergedArgs);
            const label = detail ? `${toolCall.tool_name} → ${detail}` : toolCall.tool_name;
            this.body += `\n\n🔧 ${label}\n\n`;
        }
    }
    finish(error) {
        let body = this.body;
        if (this.filter.mode === 'result' && body.trim() === '' && this.toolCalls.size > 0) {
            body = formatToolResultFallback(this.toolCalls);
        }
        body = body.replace(/\n{3,}/g, '\n\n');
        const parsedBody = parseMediaTags(body);
        let sanitizedText = sanitizeChannelReplyText(parsedBody.text);
        if (this.filter.includeToolSummary && this.toolCalls.size > 0) {
            sanitizedText += `\n\n---\n${formatToolSummary(this.toolCalls)}`;
        }
        return {
            text: sanitizedText,
            chunks: [],
            finalMessages: this.finalMessages,
            ...(parsedBody.media.length > 0 ? { media: parsedBody.media } : {}),
            ...(error ? { error } : {}),
        };
    }
}
//# sourceMappingURL=response-collector.js.map