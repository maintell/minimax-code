import { MsgType, RespDataType, ToolCallStatus, } from '@mavis/agent-core/protocol/agent-message';
import { readPtcChildExecutionDetails, readPtcExecutionDetails } from '@mavis/agent-core/tools';
import { sanitizePtcChildExecutionDetailsForSafety, sanitizePtcExecutionDetailsForSafety, } from '@mavis/agent-tools';
import { KeyedOperationLane } from '@mavis/shared/keyed-operation-lane';
import { RUNTIME_EVENT_SCHEMA, RuntimeEventStatus, RuntimeEventType, } from '@mavis/protocol';
import { reviewBlocks, SAFETY_SCENE, } from '../../../content-safety/index.js';
export const OUTPUT_SAFETY_CHUNK_THRESHOLD = 80;
export const OUTPUT_SAFETY_LOCAL_ERROR_MAX_RETRIES = 3;
export const OUTPUT_SAFETY_LOCAL_ERROR_RETRY_MAX_DELAY_MS = 5_000;
/**
 * 送审等到这么久，多半是本机后台进程太忙、没及时读到回包，而不是网络问题：失败时网络停止
 * 提示改为引导用户检查电脑负荷；不管成功失败，都会通知界面在输入框上方提示。
 */
export const SAFETY_REVIEW_SLOW_READ_MS = 15_000;
/**
 * V2-owned 先审后发 writer. It preserves producer order in one queue and releases
 * text only after threshold, phase-boundary, or final review. `finish` and the first
 * tool-call settle short text windows before their frames become releasable, so a
 * foreground tool cannot make the parent stream wait for the delayed final message.
 * Content rejection and review-network exhaustion are exposed as state for the owning
 * runner; no v1 sink is involved.
 */
export class LocalOutputSafetyEventWriter {
    inner;
    options;
    blocked = false;
    immediateBlock = false;
    guidePrompt;
    networkStopped = false;
    reviewStopVariant = 'network';
    /** 结束 `network` 软停止的那次送审等了 `SAFETY_REVIEW_SLOW_READ_MS` 以上。 */
    slowNetworkRead = false;
    terminalFailed = false;
    pendingQueue = [];
    thinkingWindow = [];
    contentWindow = [];
    threshold;
    localErrorMaxRetries;
    retryDelay;
    deliveryLane = new KeyedOperationLane();
    thinkingText = '';
    contentText = '';
    approvedThinking = '';
    approvedContent = '';
    approvedMsgId;
    safetyReviewUnknown = false;
    attemptMessageIds = new Set();
    deliveryTail = Promise.resolve();
    deliveryFailure;
    ptcParentIds = new Set();
    ptcChildObserved = false;
    constructor(inner, options) {
        this.inner = inner;
        this.options = options;
        this.threshold = options.chunkThreshold ?? OUTPUT_SAFETY_CHUNK_THRESHOLD;
        this.localErrorMaxRetries =
            options.localErrorMaxRetries ?? OUTPUT_SAFETY_LOCAL_ERROR_MAX_RETRIES;
        this.retryDelay = options.retryDelay ?? defaultLocalErrorRetryDelay;
    }
    getApprovedPartial() {
        return {
            thinking: this.approvedThinking,
            content: this.approvedContent,
            msgId: this.approvedMsgId,
        };
    }
    getAttemptMessageIds() {
        return [...this.attemptMessageIds];
    }
    hasPtcChildCalls() {
        return this.ptcChildObserved;
    }
    async pushRuntime(event) {
        if (this.options.reviewRequired === false) {
            const waitForDelivery = await this.deliveryLane.run('delivery', async () => {
                if (this.ptcLifecycleChunk(event))
                    return this.deliverRuntime(event);
                this.recordUnreviewedPartial(event);
                this.enqueueReady(event);
                return true;
            });
            if (waitForDelivery)
                await this.drain();
            return;
        }
        const waitForDelivery = await this.deliveryLane.run('delivery', () => this.deliverRuntime(event));
        if (waitForDelivery)
            await this.drain();
    }
    async deliverRuntime(event) {
        const ptc = this.ptcLifecycleChunk(event);
        if (ptc) {
            await this.deliverPtcLifecycle(event, ptc);
            return true;
        }
        if (this.blocked)
            return false;
        if (this.networkStopped) {
            await this.handleNetworkStoppedEvent(event);
            return false;
        }
        if (event.type !== RuntimeEventType.STREAM_RESP) {
            this.enqueueReady(event);
            return true;
        }
        const response = parseStreamResp(event);
        if (!response) {
            this.enqueueReady(event);
            return true;
        }
        if (response.type === RespDataType.AgentMessageChunk && response.agent_message_chunk) {
            await this.handleChunk(event, response.agent_message_chunk);
            return true;
        }
        if (response.type === RespDataType.AgentMessage && response.agent_message) {
            return this.deliverFinalMessage(event, response.agent_message);
        }
        this.enqueueReady(event);
        return true;
    }
    async deliverFinalMessage(event, message) {
        if (message.msg_type === MsgType.SystemEvent) {
            this.enqueueReady(event);
            return false;
        }
        await this.handleFinalMessage(event, message);
        return true;
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
        if (calls.some((call) => call.tool_call_status === ToolCallStatus.Start)) {
            if (this.isStopped() || !(await this.flushStreamingWindows())) {
                throw new Error('PTC start delivery was blocked by safety review; no child operation was admitted.');
            }
        }
        this.registerPtcCalls(calls);
        if (chunk.msg_id)
            this.attemptMessageIds.add(chunk.msg_id);
        const safeChunk = {
            ...chunk,
            tool_calls: this.isStopped() ? calls.map(safeStoppedPtcCall) : calls,
        };
        delete safeChunk.msg_content;
        delete safeChunk.thinking_content;
        await this.queueDelivery(() => this.inner.appendEvents([
            {
                ...event,
                payload: {
                    ...event.payload,
                    stream_resp: JSON.stringify({
                        type: RespDataType.AgentMessageChunk,
                        agent_message_chunk: safeChunk,
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
    /** BYOK output is released immediately but still needs a cancellation history snapshot. */
    recordUnreviewedPartial(event) {
        if (event.type !== RuntimeEventType.STREAM_RESP)
            return;
        const response = parseStreamResp(event);
        if (response?.type === RespDataType.AgentMessageChunk && response.agent_message_chunk) {
            this.recordReleasedText(response.agent_message_chunk, false);
        }
        else if (response?.type === RespDataType.AgentMessage &&
            response.agent_message &&
            response.agent_message.msg_type !== MsgType.SystemEvent) {
            this.recordReleasedText(response.agent_message, true);
        }
    }
    recordReleasedText(message, isFinal) {
        if (message.msg_id && message.msg_id !== this.approvedMsgId) {
            this.approvedMsgId = message.msg_id;
            this.approvedThinking = '';
            this.approvedContent = '';
            this.attemptMessageIds.add(message.msg_id);
        }
        if (message.thinking_content) {
            this.approvedThinking = isFinal
                ? message.thinking_content
                : this.approvedThinking + message.thinking_content;
        }
        if (message.msg_content && message.msg_content_source !== 'system_error') {
            this.approvedContent = isFinal
                ? message.msg_content
                : this.approvedContent + message.msg_content;
        }
    }
    async handleNetworkStoppedEvent(event) {
        if (event.type !== RuntimeEventType.SESSION_STATUS ||
            event.payload?.status !== RuntimeEventStatus.FAILED) {
            return;
        }
        this.terminalFailed = true;
        await this.queueDelivery(() => this.inner.pushRuntime(event));
    }
    async appendEvents(events) {
        if (this.options.reviewRequired === false) {
            for (const event of events) {
                await this.pushRuntime(event);
                await yieldToEventLoop();
            }
            return;
        }
        let waitForDelivery = false;
        await this.deliveryLane.run('delivery', async () => {
            for (const event of events) {
                waitForDelivery = (await this.deliverRuntime(event)) || waitForDelivery;
            }
        });
        if (waitForDelivery)
            await this.drain();
    }
    async drain() {
        await this.deliveryTail;
        if (this.deliveryFailure)
            throw this.deliveryFailure.error;
    }
    block() {
        if (this.blocked)
            return;
        this.blocked = true;
        this.clearPending();
        this.options.onBlocked?.();
    }
    async softStopNetwork(variant = 'network', slowNetworkRead = false) {
        if (this.blocked || this.networkStopped)
            return;
        this.networkStopped = true;
        this.reviewStopVariant = variant;
        this.slowNetworkRead = variant === 'network' && slowNetworkRead;
        try {
            await this.flushApprovedOnNetworkStop();
        }
        finally {
            this.clearPending();
            this.options.onBlocked?.();
        }
    }
    async handleChunk(event, chunk) {
        if (!(await this.beginMessage(chunk.msg_id)))
            return;
        if (chunk.thinking_content) {
            const pending = this.enqueuePending(event);
            this.thinkingWindow.push(pending);
            this.thinkingText += chunk.thinking_content;
            if (this.thinkingText.length >= this.threshold) {
                await this.flushStreamingWindow('thinking');
            }
            return;
        }
        if (chunk.msg_content) {
            if (!(await this.flushStreamingWindow('thinking')))
                return;
            const pending = this.enqueuePending(event);
            this.contentWindow.push(pending);
            this.contentText += chunk.msg_content;
            if (this.contentText.length >= this.threshold) {
                await this.flushStreamingWindow('content');
            }
            return;
        }
        if (isStreamingPhaseBoundary(chunk)) {
            if (!(await this.flushStreamingWindows()))
                return;
        }
        this.enqueueReady(event);
    }
    async handleFinalMessage(event, message) {
        if (!(await this.beginMessage(message.msg_id)))
            return;
        // 系统错误只用于展示；模型正文及缓冲中的输出仍需审核。
        const content = message.msg_content_source === 'system_error' ? undefined : message.msg_content;
        if (!(await this.reviewFinalWindow(message.thinking_content, this.thinkingText, SAFETY_SCENE.ThinkingContent))) {
            return;
        }
        this.approvedThinking =
            message.thinking_content && message.thinking_content.length > 0
                ? message.thinking_content
                : this.approvedThinking + this.thinkingText;
        this.releaseWindow(this.thinkingWindow);
        this.thinkingText = '';
        this.flushReady();
        if (!(await this.reviewFinalWindow(content, this.contentText, SAFETY_SCENE.MessageOutput))) {
            return;
        }
        this.approvedContent =
            content && content.length > 0 ? content : this.approvedContent + this.contentText;
        this.releaseWindow(this.contentWindow);
        this.contentText = '';
        this.enqueueReady(this.safetyReviewUnknown ? markSafetyReviewUnknown(event, message) : event);
    }
    /** Approved partials belong to one assistant message, not the entire tool loop. */
    async beginMessage(messageId) {
        if (typeof messageId !== 'string' || !messageId || messageId === this.approvedMsgId)
            return true;
        // Settle the old identity's pending window before switching. If review
        // stops here, its approved prefix must still be attributed to that message.
        if (!(await this.flushStreamingWindows()))
            return false;
        this.approvedMsgId = messageId;
        this.approvedThinking = '';
        this.approvedContent = '';
        this.attemptMessageIds.add(messageId);
        return true;
    }
    /** Settle all short streaming windows before a finish/tool-call frame can enter ready state. */
    async flushStreamingWindows() {
        if (!(await this.flushStreamingWindow('thinking')))
            return false;
        return this.flushStreamingWindow('content');
    }
    /**
     * Shared settlement path for threshold, thinking-to-content, finish, and tool-call boundaries.
     * A false result means review blocked or network-soft-stopped the attempt; callers must not
     * enqueue the current boundary frame.
     */
    async flushStreamingWindow(kind) {
        const thinking = kind === 'thinking';
        const text = thinking ? this.thinkingText : this.contentText;
        if (text.length === 0)
            return true;
        const scene = thinking ? SAFETY_SCENE.ThinkingContent : SAFETY_SCENE.StreamChunk;
        if (!(await this.review(text, scene)))
            return false;
        if (thinking) {
            this.approvedThinking += text;
            this.thinkingText = '';
            this.releaseWindow(this.thinkingWindow);
        }
        else {
            this.approvedContent += text;
            this.contentText = '';
            this.releaseWindow(this.contentWindow);
        }
        this.flushReady();
        return true;
    }
    async review(text, scene) {
        if (this.isStopped())
            return false;
        if (!text.trim())
            return true;
        const metrics = this.options.metricsClient;
        let reviewScene = scene;
        for (let attempt = 0; attempt <= this.localErrorMaxRetries; attempt += 1) {
            const startMs = Date.now();
            const result = await this.options.checkText(text, reviewScene);
            if (this.isStopped())
                return false;
            if (result.retryWithV2)
                reviewScene = sceneForV2Retry(reviewScene);
            const elapsedMs = Date.now() - startMs;
            metrics?.histogram('output_safety_check_duration_ms', elapsedMs);
            this.noticeSlowReview(elapsedMs);
            if (this.isAuthSoftStop(result)) {
                metrics?.counter('output_safety_error_total', 1, { errorKind: 'auth_error' });
                metrics?.counter('output_safety_check_total', 1, { decision: 'soft_stop_auth' });
                await this.softStopNetwork('auth');
                return false;
            }
            if (isLocalReviewError(result)) {
                metrics?.counter('output_safety_error_total', 1, { errorKind: 'local_error' });
                if (attempt < this.localErrorMaxRetries) {
                    metrics?.counter('output_safety_check_total', 1, { decision: 'local_error' });
                    await this.retryDelay();
                    continue;
                }
                metrics?.counter('output_safety_check_total', 1, { decision: 'soft_stop_network' });
                await this.softStopNetwork('network', elapsedMs >= SAFETY_REVIEW_SLOW_READ_MS);
                return false;
            }
            if (result.errorKind === 'api_error') {
                this.safetyReviewUnknown = true;
                metrics?.counter('output_safety_error_total', 1, { errorKind: 'api_error' });
            }
            return this.applyVerdict(result);
        }
        await this.softStopNetwork();
        return false;
    }
    isStopped() {
        return this.blocked || this.networkStopped;
    }
    /** 这次送审等了 `SAFETY_REVIEW_SLOW_READ_MS` 以上就通知一次，不看送审结果。 */
    noticeSlowReview(elapsedMs) {
        if (elapsedMs >= SAFETY_REVIEW_SLOW_READ_MS)
            this.options.onSlowReview?.();
    }
    isAuthSoftStop(result) {
        return result.errorKind === 'auth_error' && this.options.authErrorVariant === 'auth';
    }
    applyVerdict(result) {
        const metrics = this.options.metricsClient;
        if (result.action === 'guide') {
            this.guidePrompt = result.guide_prompt?.trim() || undefined;
            metrics?.counter('output_safety_check_total', 1, { decision: 'review' });
            this.block();
            return false;
        }
        if (reviewBlocks(result)) {
            this.immediateBlock = result.action === 'reject';
            metrics?.counter('output_safety_check_total', 1, { decision: 'block' });
            metrics?.counter('output_safety_block_total', 1);
            this.block();
            return false;
        }
        metrics?.counter('output_safety_check_total', 1, { decision: 'pass' });
        return true;
    }
    async reviewFinalWindow(completeText, windowText, scene) {
        const text = completeText && completeText.length > 0 ? completeText : windowText;
        return text ? this.review(text, scene) : true;
    }
    enqueuePending(event) {
        const pending = { event, releasable: false };
        this.pendingQueue.push(pending);
        return pending;
    }
    enqueueReady(event) {
        if (this.blocked)
            return;
        if (isTerminalEvent(event)) {
            this.clearPending();
            this.scheduleDelivery(() => this.inner.pushRuntime(event));
            return;
        }
        this.pendingQueue.push({ event, releasable: true });
        this.flushReady();
    }
    releaseWindow(window) {
        window.forEach((pending) => {
            pending.releasable = true;
        });
        window.length = 0;
    }
    flushReady() {
        const batch = [];
        while (this.pendingQueue[0]?.releasable) {
            const pending = this.pendingQueue.shift();
            if (pending)
                batch.push(pending.event);
        }
        if (batch.length > 0) {
            this.scheduleDelivery(() => this.inner.appendEvents(batch));
        }
    }
    async flushApprovedOnNetworkStop() {
        if (this.options.persistApprovedPartialOnNetworkStop === false)
            return;
        if ((!this.approvedThinking && !this.approvedContent) || !this.approvedMsgId)
            return;
        const message = {
            msg_id: this.approvedMsgId,
            role: 'assistant',
            ...(this.approvedThinking ? { thinking_content: this.approvedThinking } : {}),
            msg_content: this.approvedContent,
        };
        await this.queueDelivery(() => this.inner.pushRuntime({
            schema: RUNTIME_EVENT_SCHEMA,
            event_id: `local-output-network-stop-approved-${this.approvedMsgId}`,
            session_id: this.options.sessionId,
            turn_id: this.options.turnId,
            type: RuntimeEventType.STREAM_RESP,
            payload: {
                stream_resp: JSON.stringify({
                    type: RespDataType.AgentMessage,
                    agent_message: message,
                }),
            },
        }));
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
    clearPending() {
        this.pendingQueue.length = 0;
        this.thinkingWindow.length = 0;
        this.contentWindow.length = 0;
        this.thinkingText = '';
        this.contentText = '';
    }
}
function safeStoppedPtcCall(call) {
    const { ptcChild, ptc } = readStoppedPtcFacts(call);
    const safeChild = ptcChild ? sanitizePtcChildExecutionDetailsForSafety(ptcChild) : undefined;
    const safePtc = ptc ? sanitizePtcExecutionDetailsForSafety(ptc) : undefined;
    return {
        ...call,
        tool_call_args: JSON.stringify(safeChild?.record.input ??
            (safePtc ? { description: 'PTC execution stopped by safety review.' } : {})),
        tool_call_args_delta: '',
        tool_call_result_data: JSON.stringify({
            content: [
                {
                    type: 'text',
                    text: 'PTC execution facts were retained after safety review stopped the response. Do not replay operations with unknown outcomes automatically.',
                },
            ],
            details: safeChild ? { ptc_child: safeChild } : { ptc: safePtc },
        }),
    };
}
function readStoppedPtcFacts(call) {
    let result;
    try {
        result = JSON.parse(call.tool_call_result_data ?? 'null');
    }
    catch {
        throw new Error('PTC stopped terminal delivery has no valid host facts.');
    }
    const ptcChild = readPtcChildExecutionDetails({
        tool_call_id: call.tool_call_id,
        parent_tool_call_id: call.parent_tool_call_id,
        result,
    });
    const details = result && typeof result === 'object' ? Reflect.get(result, 'details') : undefined;
    const ptc = readPtcExecutionDetails({ role: 'toolResult', toolName: call.tool_name, details });
    if (!ptcChild && !ptc)
        throw new Error('PTC stopped terminal delivery has no trusted execution facts.');
    return { ptcChild, ptc };
}
function isPtcLifecycleCall(call) {
    return ((call.tool_name === 'run_code' || Boolean(call.parent_tool_call_id)) &&
        (call.tool_call_status === ToolCallStatus.Start ||
            call.tool_call_status === ToolCallStatus.Finished ||
            call.tool_call_status === ToolCallStatus.Failed));
}
function yieldToEventLoop() {
    return new Promise((resolve) => setImmediate(resolve));
}
function defaultLocalErrorRetryDelay() {
    const delayMs = Math.floor(Math.random() * (OUTPUT_SAFETY_LOCAL_ERROR_RETRY_MAX_DELAY_MS + 1));
    return new Promise((resolve) => setTimeout(resolve, delayMs));
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
function isLocalReviewError(result) {
    return result.errorKind === 'local_error' || result.errorKind === 'auth_error';
}
function sceneForV2Retry(scene) {
    return scene === SAFETY_SCENE.StreamChunk ? SAFETY_SCENE.MessageOutput : scene;
}
function isStreamingPhaseBoundary(chunk) {
    return chunk.finish === true || (chunk.tool_calls?.length ?? 0) > 0;
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
/**
 * Safety gateway API errors degrade-pass for delivery, but the completed
 * assistant message must retain that fact so durable query presentation does
 * not later collapse an answer whose review outcome was unknown.
 */
function markSafetyReviewUnknown(event, message) {
    return {
        ...event,
        payload: {
            ...event.payload,
            stream_resp: JSON.stringify({
                type: RespDataType.AgentMessage,
                agent_message: { ...message, safety_review_unknown: true },
            }),
        },
    };
}
//# sourceMappingURL=output-safety-event-writer.js.map