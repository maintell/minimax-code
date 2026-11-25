import { MsgType, RespDataType, ToolCallStatus, } from '@mavis/agent-core/protocol/agent-message';
import { KeyedOperationLane } from '@mavis/shared/keyed-operation-lane';
import { RuntimeEventStatus, RuntimeEventType } from '@mavis/protocol';
/**
 * 网关模式下本轮的事件出口：Pi 的帧按产生顺序原样下发（内容审核在模型网关完成，客户端不缓冲送审）。
 * 本地送审模式用的是 `output/output-safety-event-writer.ts`。
 * 它另外记下每条 assistant 消息已经显示出去的文本和消息 id：用户中止时据此落库已显示的部分，
 * 网关打回某条回复时据此判断这条消息有没有显示过、需不需要撤回。
 * `block()` 之后的帧（包括 Pi 的终态帧）全部丢弃，由 runner 按打回结果收尾。
 */
export class GatewayOutputEventWriter {
    inner;
    options;
    blocked = false;
    deliveryLane = new KeyedOperationLane();
    displayedThinking = '';
    displayedContent = '';
    displayedMsgId;
    messageIds = new Set();
    /** 下发过帧、随后又从界面撤掉的消息（被打回或被抢占作废）。 */
    withdrawnMessageIds = new Set();
    discardedMessageIds = new Set();
    deliveryTail = Promise.resolve();
    deliveryFailure;
    ptcParentIds = new Set();
    ptcChildObserved = false;
    constructor(inner, options = {}) {
        this.inner = inner;
        this.options = options;
    }
    /** 最近一条 assistant 消息已经显示出去的内容（用户中止时落库用）。 */
    getApprovedPartial() {
        return {
            thinking: this.displayedThinking,
            content: this.displayedContent,
            msgId: this.displayedMsgId,
        };
    }
    /** 本轮已经下发过帧的 assistant 消息 id。 */
    getAttemptMessageIds() {
        return [...this.messageIds];
    }
    /** 这条消息有没有任何帧下发过；网关在上游返回前就打回时，消息 id 不会出现在任何帧里。 */
    hasMessage(messageId) {
        return this.messageIds.has(messageId);
    }
    /**
     * 被打回的消息不再算“已显示的部分”，用户随后中止时不能把它落库；也不再算本轮保留下来的内容。
     * 它的 id 仍留在本轮消息里，整轮撤回时一起撤。
     */
    forgetMessage(messageId) {
        this.withdrawnMessageIds.add(messageId);
        if (this.displayedMsgId !== messageId)
            return;
        this.displayedMsgId = undefined;
        this.displayedThinking = '';
        this.displayedContent = '';
    }
    /**
     * 被抢占的回复作废：之后再到的这条消息的帧一律丢掉，也不再算已显示的部分。已经下发的帧不在这里撤，
     * 撤回事件由调用方经同一个队列另发。
     */
    discardPendingMessage(messageId) {
        if (!messageId || this.discardedMessageIds.has(messageId))
            return;
        this.discardedMessageIds.add(messageId);
        this.forgetMessage(messageId);
    }
    /** 除了这一条，本轮还有没有下发过帧、又没被撤掉的消息（工具调用、之前的回复）。 */
    hasKeptMessageOtherThan(messageId) {
        for (const id of this.messageIds) {
            if (id !== messageId && !this.withdrawnMessageIds.has(id))
                return true;
        }
        return false;
    }
    hasPtcChildCalls() {
        return this.ptcChildObserved;
    }
    async pushRuntime(event) {
        await this.deliveryLane.run('delivery', () => this.deliverRuntime(event));
        await this.drain();
    }
    async appendEvents(events) {
        for (const event of events) {
            await this.pushRuntime(event);
            await yieldToEventLoop();
        }
    }
    async drain() {
        await this.deliveryTail;
        if (this.deliveryFailure)
            throw this.deliveryFailure.error;
    }
    block() {
        this.blocked = true;
    }
    async deliverRuntime(event) {
        const ptc = this.ptcLifecycleChunk(event);
        if (ptc) {
            await this.deliverPtcLifecycle(event, ptc);
            return;
        }
        if (this.blocked || this.isDiscardedMessageEvent(event))
            return;
        this.recordDisplayed(event);
        this.scheduleDelivery(() => isTerminalEvent(event) ? this.inner.pushRuntime(event) : this.inner.appendEvents([event]));
    }
    isDiscardedMessageEvent(event) {
        if (this.discardedMessageIds.size === 0 || event.type !== RuntimeEventType.STREAM_RESP) {
            return false;
        }
        const messageId = responseMessageId(parseStreamResp(event));
        return messageId !== undefined && this.discardedMessageIds.has(messageId);
    }
    ptcLifecycleChunk(event) {
        if (this.options.ptcEnabled !== true || event.type !== RuntimeEventType.STREAM_RESP)
            return undefined;
        const response = parseStreamResp(event);
        const chunk = response?.type === RespDataType.AgentMessageChunk ? response.agent_message_chunk : undefined;
        return chunk?.tool_calls?.some(isPtcLifecycleCall) ? chunk : undefined;
    }
    async deliverPtcLifecycle(event, chunk) {
        const calls = (chunk.tool_calls ?? []).filter(isPtcLifecycleCall);
        if (this.blocked) {
            // 本轮已按打回结果收尾，不能再接纳新的子操作。
            if (calls.some((call) => call.tool_call_status === ToolCallStatus.Start)) {
                throw new Error('PTC start delivery arrived after the turn was stopped; no child operation was admitted.');
            }
            return;
        }
        this.registerPtcCalls(calls);
        if (chunk.msg_id)
            this.messageIds.add(chunk.msg_id);
        const lifecycleChunk = { ...chunk, tool_calls: calls };
        delete lifecycleChunk.msg_content;
        delete lifecycleChunk.thinking_content;
        await this.queueDelivery(() => this.inner.appendEvents([
            {
                ...event,
                payload: {
                    ...event.payload,
                    stream_resp: JSON.stringify({
                        type: RespDataType.AgentMessageChunk,
                        agent_message_chunk: lifecycleChunk,
                    }),
                },
            },
        ]));
    }
    registerPtcCalls(calls) {
        for (const call of calls) {
            if (call.parent_tool_call_id && !this.ptcParentIds.has(call.parent_tool_call_id)) {
                throw new Error('PTC child delivery has no acknowledged parent start.');
            }
            if (!call.parent_tool_call_id &&
                call.tool_name === 'run_code' &&
                call.tool_call_status === ToolCallStatus.Start) {
                this.ptcParentIds.add(call.tool_call_id);
            }
            if (call.parent_tool_call_id && call.tool_call_status === ToolCallStatus.Start)
                this.ptcChildObserved = true;
        }
    }
    recordDisplayed(event) {
        if (event.type !== RuntimeEventType.STREAM_RESP)
            return;
        const response = parseStreamResp(event);
        if (response?.type === RespDataType.AgentMessageChunk && response.agent_message_chunk) {
            this.recordDisplayedText(response.agent_message_chunk, false);
        }
        else if (response?.type === RespDataType.AgentMessage &&
            response.agent_message &&
            response.agent_message.msg_type !== MsgType.SystemEvent) {
            this.recordDisplayedText(response.agent_message, true);
        }
    }
    recordDisplayedText(message, isFinal) {
        if (message.msg_id && message.msg_id !== this.displayedMsgId) {
            this.displayedMsgId = message.msg_id;
            this.displayedThinking = '';
            this.displayedContent = '';
            this.messageIds.add(message.msg_id);
        }
        if (message.thinking_content) {
            this.displayedThinking = isFinal
                ? message.thinking_content
                : this.displayedThinking + message.thinking_content;
        }
        if (message.msg_content && message.msg_content_source !== 'system_error') {
            this.displayedContent = isFinal
                ? message.msg_content
                : this.displayedContent + message.msg_content;
        }
    }
    queueDelivery(operation) {
        const delivery = this.deliverAfter(this.deliveryTail, operation);
        this.deliveryTail = this.captureDeliveryFailure(delivery);
        return delivery;
    }
    scheduleDelivery(operation) {
        const delivery = this.deliverAfter(this.deliveryTail, operation);
        this.deliveryTail = this.captureDeliveryFailure(delivery);
    }
    async deliverAfter(previous, operation) {
        await previous;
        if (this.deliveryFailure)
            throw this.deliveryFailure.error;
        await operation();
    }
    async captureDeliveryFailure(delivery) {
        try {
            await delivery;
        }
        catch (error) {
            this.deliveryFailure ??= { error };
        }
    }
}
function isPtcLifecycleCall(call) {
    return ((call.tool_name === 'run_code' || Boolean(call.parent_tool_call_id)) &&
        (call.tool_call_status === ToolCallStatus.Start ||
            call.tool_call_status === ToolCallStatus.Finished ||
            call.tool_call_status === ToolCallStatus.Failed));
}
function responseMessageId(response) {
    if (response?.type === RespDataType.AgentMessageChunk)
        return response.agent_message_chunk?.msg_id;
    if (response?.type === RespDataType.AgentMessage)
        return response.agent_message?.msg_id;
    return undefined;
}
function yieldToEventLoop() {
    return new Promise((resolve) => setImmediate(resolve));
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
function isTerminalEvent(event) {
    if (event.type !== RuntimeEventType.SESSION_STATUS)
        return false;
    return [
        RuntimeEventStatus.COMPLETED,
        RuntimeEventStatus.FAILED,
        RuntimeEventStatus.ABORTED,
    ].includes(event.payload?.status);
}
//# sourceMappingURL=gateway-output-event-writer.js.map