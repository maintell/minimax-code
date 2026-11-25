import { toNavigationPlainText } from '@mavis/shared/navigation-text';
import { isUserSourcedWakeReason, resolveInputWakeReason, resolveTurnWakeReasons, } from '../../preparation/turn-wake-reasons.js';
import { MsgType, Role, RespDataType, ToolCallStatus, } from '@mavis/agent-core/protocol/agent-message';
import { PLAIN_TEXT_ENDING_FOLLOW_UP, emptyEndingFollowUp, plainTextEndingFollowUpAfterDelivery, readSendToUserDelivery, SEND_TO_USER_TOOL_NAME, } from '@mavis/agent-tools/send-to-user';
import { RuntimeEventType } from '@mavis/protocol';
const DELIVERY_SEPARATOR = '\n\n';
const deliveryBoundaries = new WeakSet();
/**
 * A projected chunk that carries delivered send_to_user text. It replaced a tool-call
 * frame, which the output-safety writer treated as a phase boundary, so the writer
 * settles its content window at once instead of holding a short message behind it.
 */
export function isSendToUserDeliveryBoundary(event) {
    return deliveryBoundaries.has(event);
}
/** Only turns whose top-level tools include send_to_user need the projection. */
export function hasSendToUserTool(tools) {
    return tools?.some(({ def }) => def.name === SEND_TO_USER_TOOL_NAME) ?? false;
}
/** The display projection shows a send_to_user call at its start, unless it would not deliver. */
export function showsSendToUserText(toolName, args) {
    if (toolName !== SEND_TO_USER_TOOL_NAME)
        return false;
    return readSendToUserDelivery(args) !== undefined;
}
/**
 * True when a projected event settles assistant text the user sees in the
 * conversation: ordinary assistant text or delivered send_to_user content. An
 * empty send_to_user that failed carries no text after projection. Runtime
 * warnings and runtime-written error fallbacks are not the assistant's words.
 */
export function hasVisibleAssistantText(event) {
    if (event.type !== RuntimeEventType.STREAM_RESP)
        return false;
    const response = parseStreamResp(event);
    if (response?.type !== RespDataType.AgentMessage)
        return false;
    const message = response.agent_message;
    return (message !== undefined &&
        message.role !== Role.User &&
        message.msg_type !== MsgType.SystemEvent &&
        message.msg_content_source !== 'system_error' &&
        message.kind === undefined &&
        (message.msg_content?.trim().length ?? 0) > 0);
}
/**
 * Classifies a projected stream event of the assistant's own reply.
 *
 * `content`: the model streamed something (text, thinking, a tool call, or a
 * send_to_user frame the projection emptied). `visible_text`: non-empty
 * assistant text the user sees, streamed or settled, including delivered
 * send_to_user content. User echoes, runtime notices, classified chunks
 * (`kind`) and runtime-written error fallbacks are neither.
 */
export function assistantReplyProgress(event) {
    if (event.type !== RuntimeEventType.STREAM_RESP)
        return undefined;
    const response = parseStreamResp(event);
    if (response?.type === RespDataType.AgentMessageChunk) {
        return chunkReplyProgress(response.agent_message_chunk);
    }
    if (response?.type !== RespDataType.AgentMessage)
        return undefined;
    if (!isAssistantReplyMessage(response.agent_message))
        return undefined;
    return hasVisibleAssistantText(event) ? 'visible_text' : 'content';
}
function chunkReplyProgress(chunk) {
    if (!chunk || chunk.role === Role.User || chunk.kind !== undefined)
        return undefined;
    return (chunk.msg_content?.trim().length ?? 0) > 0 ? 'visible_text' : 'content';
}
function isAssistantReplyMessage(message) {
    return (message !== undefined &&
        message.role !== Role.User &&
        message.kind === undefined &&
        message.msg_type !== MsgType.SystemEvent &&
        message.msg_content_source !== 'system_error');
}
/**
 * Display projection for Bunny's send_to_user: every display consumer downstream sees
 * delivered send_to_user content as ordinary assistant text instead of a tool row, and
 * nothing else the model wrote. Text the model wrote without the tool is never shown,
 * wherever it stands in the Turn (ADR bunny-reply-delivery). Canonical Pi history is
 * written elsewhere and keeps the real text, tool call and result. Events are rewritten
 * in place, never dropped, so runtime_seq stays contiguous.
 */
export class SendToUserDisplayProjectionWriter {
    inner;
    replyOrigin;
    streamedMessageIds = new Set();
    constructor(inner, replyOrigin) {
        this.inner = inner;
        this.replyOrigin = replyOrigin;
    }
    replyOrigins = new Map();
    replyFields(id, quoteQuestion = false) {
        if (!this.replyOrigins.has(id)) {
            const source = this.replyOrigin?.();
            this.replyOrigins.set(id, source && { ...source, quoteQuestion });
        }
        const origin = this.replyOrigins.get(id);
        return origin ? { origin, parent_msg_id: origin.messageId } : {};
    }
    pushRuntime(event) {
        return this.inner.pushRuntime(this.project(event));
    }
    appendEvents(events) {
        return this.inner.appendEvents(events.map((event) => this.project(event)));
    }
    project(event) {
        if (event.type !== RuntimeEventType.STREAM_RESP)
            return event;
        const response = parseStreamResp(event);
        if (response?.type === RespDataType.AgentMessageChunk && response.agent_message_chunk) {
            return this.projectChunk(event, response.agent_message_chunk);
        }
        if (response?.type === RespDataType.AgentMessage && response.agent_message) {
            return this.projectSettled(event, response.agent_message);
        }
        return event;
    }
    projectSettled(event, message) {
        if (!isAssistantReplyMessage(message))
            return event;
        const delivered = deliveredContents(message.tool_calls ?? [], (call) => call.tool_call_status !== ToolCallStatus.Failed);
        return projectMessage(event, delivered.length
            ? { ...message, ...this.replyFields(message.msg_id, delivered[0]?.quoteQuestion) }
            : message, delivered);
    }
    projectChunk(event, chunk) {
        if (chunk.role === Role.User || chunk.kind !== undefined)
            return event;
        const calls = chunk.tool_calls ?? [];
        if (!calls.some(isSendToUserCall)) {
            if (!chunk.msg_content)
                return event;
            const projected = { ...chunk };
            delete projected.msg_content;
            return withStreamResp(event, {
                type: RespDataType.AgentMessageChunk,
                agent_message_chunk: projected,
            });
        }
        const delivered = deliveredContents(calls, (call) => call.tool_call_status === ToolCallStatus.Start);
        const projected = { ...chunk };
        const kept = calls.filter((call) => !isSendToUserCall(call));
        if (kept.length > 0)
            projected.tool_calls = kept;
        else
            delete projected.tool_calls;
        delete projected.msg_content;
        if (delivered.length) {
            Object.assign(projected, this.replyFields(chunk.msg_id, delivered[0]?.quoteQuestion));
        }
        const text = this.appendDelivered(chunk, delivered);
        if (text)
            projected.msg_content = text;
        const next = withStreamResp(event, {
            type: RespDataType.AgentMessageChunk,
            agent_message_chunk: projected,
        });
        if (delivered.length > 0)
            deliveryBoundaries.add(next);
        return next;
    }
    appendDelivered(chunk, delivered) {
        let text = '';
        let streamed = this.streamedMessageIds.has(chunk.msg_id);
        for (const { content } of delivered) {
            text += (streamed ? DELIVERY_SEPARATOR : '') + content;
            streamed = true;
        }
        if (streamed && chunk.msg_id)
            this.streamedMessageIds.add(chunk.msg_id);
        return text;
    }
}
function projectMessage(event, message, delivered) {
    const calls = message.tool_calls ?? [];
    if (!message.msg_content && !calls.some(isSendToUserCall))
        return event;
    const projected = { ...message };
    const kept = calls.filter((call) => !isSendToUserCall(call));
    if (kept.length > 0) {
        projected.tool_calls = kept;
    }
    else {
        delete projected.tool_calls;
        projected.msg_type = MsgType.AgentContent;
    }
    if (delivered.length)
        projected.msg_content = delivered.map((part) => part.content).join(DELIVERY_SEPARATOR);
    else
        delete projected.msg_content;
    return withStreamResp(event, { type: RespDataType.AgentMessage, agent_message: projected });
}
/** Top-level calls only; a run_code child named send_to_user is refused by PTC policy. */
function isSendToUserCall(call) {
    return call.tool_name === SEND_TO_USER_TOOL_NAME && !call.parent_tool_call_id;
}
function deliveredContents(calls, include) {
    return calls.flatMap((call) => {
        if (!isSendToUserCall(call) || !include(call))
            return [];
        const delivery = readDelivery(call.tool_call_args);
        return delivery ? [delivery] : [];
    });
}
function readDelivery(rawArgs) {
    if (!rawArgs)
        return undefined;
    try {
        return readSendToUserDelivery(JSON.parse(rawArgs));
    }
    catch {
        return undefined;
    }
}
function parseStreamResp(event) {
    const raw = event.payload?.stream_resp;
    if (typeof raw !== 'string' || raw.length === 0)
        return undefined;
    try {
        return JSON.parse(raw);
    }
    catch {
        return undefined;
    }
}
function withStreamResp(event, response) {
    return {
        ...event,
        payload: { ...event.payload, stream_resp: JSON.stringify(response) },
    };
}
function bunnyReplyOrigin(request) {
    if (!request.userMessageId ||
        !isUserSourcedWakeReason(resolveInputWakeReason({
            provenance: request.provenance,
            origin: request.input.origin,
        })))
        return undefined;
    const text = toNavigationPlainText(request.genuineUserQueryText).slice(0, 240);
    const files = (request.input.attachments ?? []).slice(0, 12).map((file) => {
        const path = file.desktopPath || file.filePath || '';
        return {
            name: file.fileName ?? '',
            mime: file.mimeType || (file.type === 'image' ? 'image/unknown' : ''),
            path: /^(?:blob|data):/i.test(path) ? '' : path,
            ...(file.assetId && { assetId: file.assetId }),
        };
    });
    if (!text && !files.length)
        return undefined;
    return { kind: 'bunny-reply', messageId: request.userMessageId, text, files };
}
export function createBunnyReplyOriginTracker(request, enabled) {
    if (!enabled)
        return undefined;
    const members = request.immediateSendBatch?.members;
    const initial = members?.[0] ?? request;
    let origin = (members?.length ?? 0) < 2 && !request.input?.queuedMessages?.length
        ? bunnyReplyOrigin(initial)
        : undefined;
    return {
        current: () => origin,
        accept(item) {
            origin =
                item && !item.delivery?.hideUserMessage
                    ? bunnyReplyOrigin({ ...item, input: item.message })
                    : undefined;
        },
    };
}
const PLAIN_TEXT_ENDING_FOLLOW_UP_REASON = 'plain_text_ending';
/**
 * Bunny's main conversation shows only what `send_to_user` delivered (ADR
 * bunny-reply-delivery). When a Turn that took in user input ends with a reply
 * of plain text and no tool call, the user sees nothing of it: the reply is
 * kept and the model is asked once more to deliver what the user needs and to
 * finish what the Turn left undone. Once the Turn has delivered something, the
 * question says how many messages the user already saw, so a closing remark on
 * them is answered with “无” instead of being sent again. Asked at most once
 * per Turn; a Turn woken by system events alone is never asked, its plain text
 * simply stays unseen.
 */
export function createPlainTextEndingFollowUp(input, repliesThroughSendToUser, bunnyMainConversation) {
    if (!repliesThroughSendToUser || !bunnyMainConversation)
        return undefined;
    let tookUserInput = resolveTurnWakeReasons(input.request).some(isUserSourcedWakeReason);
    let asked = false;
    // This Turn's send_to_user calls with content to show. A later hook may still reject
    // the response that carries one, so a call counts only once its tool result is in
    // the transcript.
    const sendCalls = new Set();
    return {
        afterLlmCall: ({ message, messages }) => {
            if (message.stopReason === 'error' || message.stopReason === 'aborted')
                return undefined;
            recordSendCalls(sendCalls, message.content);
            if (asked || !tookUserInput || hasToolCallBlock(message.content))
                return undefined;
            asked = true;
            const delivered = countDeliveredSendCalls(messages, sendCalls);
            return {
                type: 'followUp',
                reason: PLAIN_TEXT_ENDING_FOLLOW_UP_REASON,
                prompt: endingFollowUpPrompt(joinedText(message.content), delivered),
            };
        },
        recordConsumedSteering: (item) => {
            const reason = resolveInputWakeReason({
                provenance: item.provenance,
                origin: item.message.origin,
            });
            if (isUserSourcedWakeReason(reason))
                tookUserInput = true;
        },
    };
}
function recordSendCalls(sendCalls, content) {
    for (const block of content) {
        if (block.type === 'toolCall' &&
            block.id &&
            block.name &&
            showsSendToUserText(block.name, block.arguments)) {
            sendCalls.add(block.id);
        }
    }
}
function hasToolCallBlock(content) {
    return content.some((block) => block.type === 'toolCall');
}
function joinedText(content) {
    return content
        .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
        .join('')
        .trim();
}
function countDeliveredSendCalls(messages, sendCalls) {
    return messages.filter((item) => item.role === 'toolResult' &&
        item.toolCallId !== undefined &&
        sendCalls.has(item.toolCallId) &&
        !item.isError).length;
}
function endingFollowUpPrompt(text, delivered) {
    if (!text)
        return emptyEndingFollowUp(delivered);
    return delivered ? plainTextEndingFollowUpAfterDelivery(delivered) : PLAIN_TEXT_ENDING_FOLLOW_UP;
}
/** The Turn's after_llm_call hooks, with the follow-up last when the Turn has one. */
export function withPlainTextEndingHook(hooks, followUp) {
    return followUp ? [...hooks, followUp.afterLlmCall] : hooks;
}
//# sourceMappingURL=send-to-user-display-projection.js.map