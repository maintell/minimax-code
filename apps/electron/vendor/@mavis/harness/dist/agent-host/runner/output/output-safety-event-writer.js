import { MsgType, RespDataType, ToolCallStatus, } from '@mavis/agent-core/protocol/agent-message';
import { readPtcChildExecutionDetails, readPtcExecutionDetails } from '@mavis/agent-core/tools';
import { sanitizePtcChildExecutionDetailsForSafety, sanitizePtcExecutionDetailsForSafety, } from '@mavis/agent-tools/ptc';
import { KeyedOperationLane } from '@mavis/shared/keyed-operation-lane';
import { observeMetric } from '@mavis/shared/local-runtime-logging/metrics';
import { RUNTIME_EVENT_SCHEMA, RuntimeEventStatus, RuntimeEventType, } from '@mavis/protocol';
import { dialogReviewBlocks, dialogReviewUnavailable, SAFETY_SCENE, } from '@mavis/shared/local-runtime-safety';
import { isSendToUserDeliveryBoundary } from './send-to-user-display-projection.js';
export const OUTPUT_SAFETY_CHUNK_THRESHOLD = 80;
export const OUTPUT_SAFETY_LOCAL_ERROR_MAX_RETRIES = 3;
export const OUTPUT_SAFETY_LOCAL_ERROR_RETRY_MAX_DELAY_MS = 5_000;
/**
 * 送审等到这么久，多半是本机后台进程太忙、没及时读到回包，而不是网络问题：失败时网络停止
 * 提示改为引导用户检查电脑负荷；不管成功失败，都会通知界面在输入框上方提示。
 */
export const SAFETY_REVIEW_SLOW_READ_MS = 15_000;
/**
 * 统计单次送审在进程唤醒状态下的耗时：系统休眠（suspend）期间 `Date.now()` 继续累加而
 * `performance.now()` 暂停，取两者较小值避免把合盖休眠时间误判为慢送审。
 * 仅 mock `Date.now` 的单测沿用墙钟。
 */
export function measureReviewElapsedMs(startMs, startPerfMs) {
    const wallElapsedMs = Math.max(0, Date.now() - startMs);
    if ('mock' in Date.now && !('mock' in performance.now))
        return wallElapsedMs;
    const monotonicElapsedMs = Math.max(0, performance.now() - startPerfMs);
    return Math.min(wallElapsedMs, monotonicElapsedMs);
}
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
    attemptMessageIds = new Set();
    discardedMessageIds = new Set();
    deliveryTail = Promise.resolve();
    deliveryFailure;
    ptcParentIds = new Set();
    ptcChildObserved = false;
    /** When the first body text entered the review window. */
    firstContentAtMs;
    firstChunkMeasured = false;
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
    /**
     * A preempted response is void: nothing it left in the review window may
     * reach the user, and nothing already released for it may be re-persisted as
     * an approved partial. Dropping the window alone cannot restore delivery
     * order — earlier messages of the same Turn may still hold tails — so the
     * retraction itself is routed through this writer's queue.
     */
    discardPendingMessage(messageId) {
        if (!messageId || this.discardedMessageIds.has(messageId))
            return;
        this.discardedMessageIds.add(messageId);
        dropPendingMessage(this.pendingQueue, messageId);
        dropPendingMessage(this.thinkingWindow, messageId);
        dropPendingMessage(this.contentWindow, messageId);
        // The streaming windows always belong to `approvedMsgId`; `beginMessage`
        // settles them before switching identity.
        if (this.approvedMsgId === messageId) {
            this.approvedMsgId = undefined;
            this.approvedThinking = '';
            this.approvedContent = '';
            this.thinkingText = '';
            this.contentText = '';
        }
        this.flushReady();
    }
    hasPtcChildCalls() {
        return this.ptcChildObserved;
    }
    async pushRuntime(event) {
        if (this.options.reviewRequired === false) {
            const waitForDelivery = await this.deliveryLane.run('delivery', async () => {
                if (this.ptcLifecycleChunk(event))
                    return this.deliverRuntime(event);
                if (isDiscardedMessageEvent(event, this.discardedMessageIds))
                    return false;
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
        return this.deliverStreamResp(event);
    }
    /**
     * The STREAM_RESP half of `deliverRuntime`: parse the response once, drop a
     * discarded message before it can be released, and route a chunk or a final
     * message. Anything else is a pass-through event.
     */
    async deliverStreamResp(event) {
        if (event.type !== RuntimeEventType.STREAM_RESP) {
            this.enqueueReady(event);
            return true;
        }
        const response = parseStreamResp(event);
        if (!response) {
            this.enqueueReady(event);
            return true;
        }
        return this.deliverResponse(event, response);
    }
    async deliverResponse(event, response) {
        if (isDiscardedResponse(response, this.discardedMessageIds))
            return false;
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
            this.noteFirstContent();
            this.contentText += chunk.msg_content;
            if (this.contentText.length >= this.threshold || isSendToUserDeliveryBoundary(event)) {
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
        this.enqueueReady(event);
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
        const finishFirstChunk = this.startFirstChunkReview(scene);
        try {
            return await this.reviewText(text, scene);
        }
        finally {
            finishFirstChunk?.();
        }
    }
    /** The first body text entered the review window: `buffer_wait` starts here. */
    noteFirstContent() {
        this.firstContentAtMs ??= Date.now();
    }
    /**
     * Times the review of the first body-text window: how long its first text
     * waited in the window (80 characters, a boundary or the final message),
     * then the review itself, local-error retries included.
     */
    startFirstChunkReview(scene) {
        const caller = this.options.firstChunkCaller;
        const body = scene === SAFETY_SCENE.StreamChunk || scene === SAFETY_SCENE.MessageOutput;
        if (!caller || !body || this.firstChunkMeasured)
            return undefined;
        this.firstChunkMeasured = true;
        const sink = this.options.metricsClient;
        const startedAtMs = Date.now();
        if (this.firstContentAtMs !== undefined) {
            const waitedMs = startedAtMs - this.firstContentAtMs;
            observeMetric(sink, 'output_safety_first_chunk_ms', waitedMs, {
                stage: 'buffer_wait',
                caller,
            });
        }
        return () => observeMetric(sink, 'output_safety_first_chunk_ms', Date.now() - startedAtMs, {
            stage: 'check',
            caller,
        });
    }
    async reviewText(text, scene) {
        const metrics = this.options.metricsClient;
        let reviewScene = scene;
        for (let attempt = 0; attempt <= this.localErrorMaxRetries; attempt += 1) {
            const startMs = Date.now();
            const startPerfMs = performance.now();
            const result = await this.options.checkText(text, reviewScene);
            if (this.isStopped())
                return false;
            if (result.retryWithV2)
                reviewScene = sceneForV2Retry(reviewScene);
            const elapsedMs = measureReviewElapsedMs(startMs, startPerfMs);
            metrics?.histogram('output_safety_check_duration_ms', elapsedMs);
            if (this.isAuthSoftStop(result)) {
                this.noticeSlowReview(elapsedMs);
                metrics?.counter('output_safety_error_total', 1, { errorKind: 'auth_error' });
                metrics?.counter('output_safety_check_total', 1, { decision: 'soft_stop_auth' });
                this.options.onReviewUnavailable?.(scene);
                await this.softStopNetwork('auth');
                return false;
            }
            if (dialogReviewUnavailable(result)) {
                const nextAttempt = await this.retryUnavailable(result, attempt, elapsedMs, scene);
                if (nextAttempt === undefined)
                    return false;
                attempt = nextAttempt;
                continue;
            }
            return this.settleReviewedChunk(result, elapsedMs);
        }
        await this.softStopNetwork();
        return false;
    }
    /**
     * An unavailable review (transport, auth or gateway failure) resends for free once an
     * offline device is back, retries within the budget, then soft-stops the attempt with the
     * `network` variant. Returns the loop attempt counter before increment, or undefined once
     * the Turn soft-stopped or the user stopped it.
     */
    async retryUnavailable(result, attempt, elapsedMs, scene) {
        const metrics = this.options.metricsClient;
        metrics?.counter('output_safety_error_total', 1, {
            errorKind: result.errorKind === 'api_error' ? 'api_error' : 'local_error',
        });
        // A reconnect starts a fresh retry budget; an in-place retry spends one.
        if (await this.waitWhileOffline())
            return -1;
        if (this.options.signal?.aborted)
            return undefined;
        if (attempt < this.localErrorMaxRetries) {
            metrics?.counter('output_safety_check_total', 1, { decision: 'local_error' });
            await this.retryDelay();
            return this.options.signal?.aborted ? undefined : attempt;
        }
        metrics?.counter('output_safety_check_total', 1, { decision: 'soft_stop_network' });
        this.noticeSlowReview(elapsedMs);
        this.options.onReviewUnavailable?.(scene);
        await this.softStopNetwork('network', elapsedMs >= SAFETY_REVIEW_SLOW_READ_MS);
        return undefined;
    }
    isStopped() {
        return this.blocked || this.networkStopped;
    }
    /** True once an offline device is back, so the same window is resent for free. */
    async waitWhileOffline() {
        const online = (await this.options.offlineWait?.untilOnline()) === true;
        return online && !this.isStopped();
    }
    /**
     * A review that gave a verdict. Dialog review fails closed, so an `api_error` never
     * reaches here: `dialogReviewUnavailable` routes it to `retryUnavailable` instead.
     */
    settleReviewedChunk(result, elapsedMs) {
        this.noticeSlowReview(elapsedMs);
        const approved = this.applyVerdict(result);
        if (approved && elapsedMs < SAFETY_REVIEW_SLOW_READ_MS && result.errorKind !== 'api_error') {
            this.options.onSlowReviewCleared?.();
        }
        return approved;
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
        if (dialogReviewBlocks(result)) {
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
function responseMessageId(response) {
    if (response.type === RespDataType.AgentMessageChunk)
        return response.agent_message_chunk?.msg_id;
    if (response.type === RespDataType.AgentMessage)
        return response.agent_message?.msg_id;
    return undefined;
}
function streamMessageId(event) {
    if (event.type !== RuntimeEventType.STREAM_RESP)
        return undefined;
    const response = parseStreamResp(event);
    return response ? responseMessageId(response) : undefined;
}
function isDiscardedMessageEvent(event, discarded) {
    const messageId = streamMessageId(event);
    return messageId !== undefined && discarded.has(messageId);
}
/** Same check as `isDiscardedMessageEvent`, reusing an already parsed payload. */
function isDiscardedResponse(response, discarded) {
    const messageId = responseMessageId(response);
    return messageId !== undefined && discarded.has(messageId);
}
function dropPendingMessage(queue, messageId) {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
        const pending = queue[index];
        if (pending && streamMessageId(pending.event) === messageId)
            queue.splice(index, 1);
    }
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
//# sourceMappingURL=output-safety-event-writer.js.map