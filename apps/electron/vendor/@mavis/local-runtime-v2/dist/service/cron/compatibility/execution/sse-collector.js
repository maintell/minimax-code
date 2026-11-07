import { MsgType, RespDataType, Role, ToolCallStatus, } from '@mavis/agent-core/protocol/agent-message';
import { parseMediaTags } from '@mavis/shared';
import { parseRespData } from '../../../../infra/transport/http-helpers.js';
import { extractToolDetail, formatToolResultFallback, formatToolSummary, sanitizeChannelReplyText, } from '../message-format.js';
const DEFAULT_MESSAGE_FILTER = {
    mode: 'result',
    includeToolSummary: false,
};
/** Collect SSE frames in arrival order, preserving the legacy rendering modes. */
export function collectChannelResponseFromSse(raw, filter, options) {
    const response = new ChannelResponseAccumulator(filter ?? DEFAULT_MESSAGE_FILTER, options);
    const chunkMsgIds = new Set();
    const thinkingMsgIds = new Set();
    let error;
    for (const data of decodeSseData(raw)) {
        if (data === '[DONE]')
            continue;
        const parsed = safeJson(data);
        if (isErrorFrame(parsed)) {
            error = parsed.error;
            continue;
        }
        const resp = parseRespData(data);
        if (!resp || resp.type === RespDataType.Heartbeat)
            continue;
        response.appendFrame(resp, collectTextFromResp(resp, chunkMsgIds), collectAuxFromResp(resp, thinkingMsgIds));
    }
    return response.finish(error);
}
/** Per-call accumulation only; no state survives a collection. */
class ChannelResponseAccumulator {
    filter;
    options;
    body = '';
    seenToolCall = false;
    chunks = [];
    toolCalls = new Map();
    finalMessages = 0;
    constructor(filter, options) {
        this.filter = filter;
        this.options = options;
    }
    appendFrame(resp, next, aux) {
        if (next.finalMessage)
            this.finalMessages += 1;
        this.appendToolCalls(aux.toolCalls, resp.type === RespDataType.AgentMessageChunk);
        this.appendText(next.finalText);
        this.appendThinking(aux.thinking);
        if (next.chunk) {
            this.chunks.push(next.chunk);
            this.appendText(next.chunk);
        }
    }
    appendMessage(message) {
        if (message.role === 'user' || message.role === 'system' || message.kind === 'compaction')
            return;
        this.finalMessages += 1;
        this.appendToolCalls(message.toolCalls, true);
        this.appendText(message.text);
        this.appendThinking(message.thinking);
    }
    appendToolCalls(calls, isChunk) {
        if (!calls?.length)
            return;
        for (const toolCall of calls) {
            const previous = this.toolCalls.get(toolCall.tool_call_id);
            // A final frame may omit arguments already supplied by its start frame.
            const args = toolCall.tool_call_args || previous?.tool_call_args;
            this.toolCalls.set(toolCall.tool_call_id, { ...toolCall, tool_call_args: args });
            if (isChunk && this.filter.mode === 'full' && toolCall.tool_call_status !== ToolCallStatus.Finished) {
                this.body += formatInlineToolCall(toolCall, args);
            }
        }
        if (isChunk && this.filter.mode === 'result')
            this.seenToolCall = true;
    }
    appendText(text) {
        if (!text)
            return;
        // Only the next text segment consumes a tool-call boundary. Thinking does not.
        if (this.filter.mode === 'result' && this.seenToolCall) {
            if (!this.options?.preserveAssistantTextAcrossToolCalls)
                this.body = '';
            this.seenToolCall = false;
        }
        this.body += text;
    }
    appendThinking(thinking) {
        if (thinking && this.filter.mode === 'full')
            this.body += thinking;
    }
    finish(error) {
        if (this.filter.mode === 'result' && this.body.trim() === '' && this.toolCalls.size > 0) {
            this.body = formatToolResultFallback(this.toolCalls);
        }
        // Extract media from the agent body before appending the tool-summary suffix.
        const parsedBody = parseMediaTags(this.body.replace(/\n{3,}/g, '\n\n'));
        let text = sanitizeChannelReplyText(parsedBody.text);
        if (this.filter.includeToolSummary && this.toolCalls.size > 0) {
            text += `\n\n---\n${formatToolSummary(this.toolCalls)}`;
        }
        return {
            text,
            chunks: this.chunks,
            finalMessages: this.finalMessages,
            ...(parsedBody.media.length > 0 ? { media: parsedBody.media } : {}),
            ...(error ? { error } : {}),
        };
    }
}
function formatInlineToolCall(toolCall, args) {
    const detail = extractToolDetail(toolCall.tool_name, args);
    const label = detail ? `${toolCall.tool_name} → ${detail}` : toolCall.tool_name;
    return `\n\n🔧 ${label}\n\n`;
}
function collectTextFromResp(resp, chunkMsgIds) {
    if (resp.type === RespDataType.AgentMessageChunk && resp.agent_message_chunk) {
        const chunk = resp.agent_message_chunk.msg_content;
        if (resp.agent_message_chunk.msg_id)
            chunkMsgIds.add(resp.agent_message_chunk.msg_id);
        return { ...(chunk ? { chunk } : {}), finalMessage: false };
    }
    if (resp.type === RespDataType.AgentMessage && resp.agent_message) {
        return collectFinalText(resp.agent_message, chunkMsgIds);
    }
    return { finalMessage: false };
}
function collectFinalText(message, chunkMsgIds) {
    if (message.role === Role.User || message.msg_type === MsgType.SystemEvent)
        return { finalMessage: false };
    const duplicated = message.msg_id ? chunkMsgIds.has(message.msg_id) : false;
    return {
        ...(message.msg_content && !duplicated ? { finalText: message.msg_content } : {}),
        finalMessage: true,
    };
}
/** Thinking dedup is independent of text dedup, and compaction thinking stays internal. */
function collectAuxFromResp(resp, thinkingMsgIds) {
    if (resp.type === RespDataType.AgentMessageChunk && resp.agent_message_chunk) {
        return collectChunkAux(resp.agent_message_chunk, thinkingMsgIds);
    }
    if (resp.type === RespDataType.AgentMessage && resp.agent_message) {
        return collectFinalAux(resp.agent_message, thinkingMsgIds);
    }
    return {};
}
function collectChunkAux(chunk, thinkingMsgIds) {
    const out = {};
    if (chunk.tool_calls && chunk.tool_calls.length > 0)
        out.toolCalls = chunk.tool_calls;
    if (chunk.thinking_content && chunk.kind !== 'compaction') {
        if (chunk.msg_id)
            thinkingMsgIds.add(chunk.msg_id);
        out.thinking = chunk.thinking_content;
    }
    return out;
}
function collectFinalAux(message, thinkingMsgIds) {
    if (message.role === Role.User || message.msg_type === MsgType.SystemEvent)
        return {};
    const out = {};
    if (message.tool_calls && message.tool_calls.length > 0)
        out.toolCalls = message.tool_calls;
    const duplicated = message.msg_id ? thinkingMsgIds.has(message.msg_id) : false;
    if (message.thinking_content && message.kind !== 'compaction' && !duplicated)
        out.thinking = message.thinking_content;
    return out;
}
function decodeSseData(raw) {
    return raw.split(/\n\n/u).flatMap((event) => {
        const dataLines = event.split(/\r?\n/u)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /u, ''));
        return dataLines.length > 0 ? [dataLines.join('\n')] : [];
    });
}
function safeJson(value) {
    try {
        return JSON.parse(value);
    }
    catch {
        return undefined;
    }
}
function isErrorFrame(value) {
    return !!value && typeof value === 'object' &&
        value.type === 'error' &&
        typeof value.error === 'string';
}
//# sourceMappingURL=sse-collector.js.map