import { RespDataType } from '@mavis/agent-core/protocol/agent-message';
import { RuntimeEventStatus, RuntimeEventType } from '@mavis/protocol';
import { reviewBlocks, SAFETY_SCENE } from '../content-safety/api.js';
import { defaultOutputSafetyLocalErrorRetryDelay, OUTPUT_SAFETY_CHUNK_THRESHOLD, OUTPUT_SAFETY_LOCAL_ERROR_MAX_RETRIES, } from './output-safety-deps.js';
import { OutputSafetyV2GuideState } from './output-safety-v2-guide-state.js';
import { parseStreamResp } from './output-safety-pending-event.js';
import { flushApprovedOnNetworkStop } from './output-safety-flush-approved.js';
export { OUTPUT_SAFETY_CHUNK_THRESHOLD, OUTPUT_SAFETY_LOCAL_ERROR_MAX_RETRIES, OUTPUT_SAFETY_LOCAL_ERROR_RETRY_MAX_DELAY_MS, } from './output-safety-deps.js';
/**
 * Output-review event writer — 本地链路的「先审后发」出口。
 *
 * agent-core 会不断吐 `stream.resp`，其中既有用户能看到的 text/thinking
 * chunk，也有 finish/tool-call 等非文本 chunk。文本 chunk 必须先做安全审核；
 * 非文本 chunk 本身不用审，但它们在 SSE 里仍然带着 producer 顺序，不能因为
 * “不用审”就抢跑到前面的文本 chunk 之前。
 *
 * 这个 writer 因此维护一条统一的 pendingQueue：
 * 1. 所有 `stream.resp` 都按 agent-core 生产顺序入队；
 * 2. text/thinking chunk 入队时先标记为不可释放，等覆盖它的审核窗口通过；
 * 3. finish/首个 tool-call 是明确的流式 phase 边界：先结算剩余短文本窗口，再把
 *    边界 chunk 标记为可释放；其它 no-text chunk 仍只入队等待；
 * 4. 最终完整 AgentMessage 会再做一次全文审核，然后把 final event 按原始顺序释放。
 *
 * 这样做的关键目标是：SSE 上游看到的 chunk_index / producer order 必须和
 * agent-core 原始输出一致；同时任何未通过审核的内容都不能泄露给 UI。
 *
 * 两种异常出口都只设标记、丢弃尚未透传的内容，不向外抛异常（pi 的事件循环会
 * 吞掉 writer 异常，抛错无法可靠驱动后续处理）：
 *   - 内容裁定 `rejected` → 设 {@link blocked}，host 走撤回+重生成；
 *   - 安审接口 `local_error` 重试耗尽 → 设 {@link networkStopped}，host 走
 *     保留已过审 + 网络提示，不撤回用户输入。
 * host 在 `runTurn` resolve 后读取这两个标记，这才是稳定的阻断信号。
 */
export class LocalOutputSafetyEventWriter {
    /** 当前 attempt 是否已被输出安全审核阻断；host 在 runTurn 结束后读取它。 */
    blocked = false;
    /** V2 hard rejection or auth failure must not enter the regeneration loop. */
    immediateBlock = false;
    // V2 guide review 状态委托给独立 state 类(保持 layout gate 500 行预算)
    v2GuideState = new OutputSafetyV2GuideState();
    /** An explicit V2 Review supplied a model-only instruction for the next attempt. */
    get guideReviewed() {
        return this.v2GuideState.isGuideReviewed();
    }
    /**
     * 当前 attempt 是否因为安审接口 `local_error` 连续重试耗尽而「软停」。
     *
     * 与 {@link blocked} 的关键区别：`local_error` 是网络/接口故障而非内容裁定。
     * 软停时：已过审并 flush 的内容【保留】，只丢弃当前未过审窗口（可能永远拿不到
     * 裁定，不能泄露），abort 掉仍在生成的 pi turn 结束本轮不重生成；host 读到该
     * 标记后【不 retract 整轮、不撤回用户输入气泡】，只在输入框上方显示网络提示条。
     */
    networkStopped = false;
    /** A runtime FAILED terminal observed after this attempt soft-stopped. */
    terminalFailed = false;
    /**
     * 已过审(已 flush)的 thinking / content 前缀快照，供 host 在网络软停后把 pi
     * history 里那条 assistant 消息重写成「仅已过审前缀」——`onHistoryChangedHook`
     * 落进 pi history 的是 pi 完整输出（含未过审尾巴），不清理会在下一轮把没过审、
     * 用户也没看到的内容当上下文喂给模型。
     */
    getApprovedPartial() {
        return {
            thinking: this.approvedThinking,
            content: this.approvedContent,
            msgId: this.approvedMsgId,
        };
    }
    inner;
    deps;
    threshold;
    localErrorMaxRetries;
    retryDelay;
    /**
     * V2: 取最近一次 review 命中的 `guide_prompt`(V2 SafetyCheckV2.Action=Guide
     * 携带的模型侧引导提示词)并清空状态。取不到返回 `undefined`,host 应
     * 回退到 `OUTPUT_REVISION_INSTRUCTION` 固定文本。
     */
    consumeGuidePrompt() {
        return this.v2GuideState.consume();
    }
    /** V2: 重置 guide review 状态(每个 attempt 边界 host 调一次)。 */
    resetGuideReview() {
        this.v2GuideState.reset();
    }
    /**
     * 所有还没真正写给上游的 `stream.resp` 都在这里排队。
     *
     * 注意这里不能按 thinking/content/finish 分多个队列分别 flush。bug 的根因就是：
     * 某些 frame（例如 finish 或 tool-call delta）没有可审核文本，会被认为“立刻可发”；
     * 如果它绕过了前面仍在等待审核的 text/thinking chunk，上游 SSE 就会观察到乱序。
     *
     * 统一队列的释放规则非常保守：只 flush 队首连续 `releasable=true` 的前缀。
     * 后面的事件即使已经安全，也必须等它前面的事件先变安全。
     */
    pendingQueue = [];
    /**
     * 当前 thinking 审核窗口中包含的 pending 事件引用。
     * 审核通过时，会把这些事件在 `pendingQueue` 中标记为可释放；事件本身不搬家。
     */
    thinkingWindow = [];
    /**
     * 当前正文审核窗口中包含的 pending 事件引用。
     * content 和 thinking 分开审核，是因为它们使用不同的 SafetyScene。
     */
    contentWindow = [];
    /** 当前 thinking 滑动窗口累计的文本；达到 threshold、phase 边界或 final 时审核。 */
    thinkingText = '';
    /** 当前正文滑动窗口累计的文本；达到 threshold、phase 边界或 final 时审核。 */
    contentText = '';
    /**
     * 已经通过审核（已 releaseWindow）的 thinking / content 累计全文。
     *
     * 软停（`local_error` 重试耗尽）时用它合成一条「只含已过审部分」的 final
     * AgentMessage 透传给 sink，让 host 的 `observeFrame` 落库 —— 否则本地链路只有
     * final AgentMessage 事件会触发持久化，软停时该事件走不到 sink，已过审的
     * thinking / content 只剩流式残帧，一次 refetch/rewind 就丢了。
     */
    approvedThinking = '';
    approvedContent = '';
    /**
     * 最近一次见到的 assistant msg_id（chunk 或 final 都会带，同一条 message 共享）。
     * 软停合成保留消息时复用它，让落库/流式与已经显示的流式 chunk 归并成同一条。
     */
    approvedMsgId;
    constructor(inner, deps) {
        this.inner = inner;
        this.deps = deps;
        this.threshold = deps.chunkThreshold ?? OUTPUT_SAFETY_CHUNK_THRESHOLD;
        this.localErrorMaxRetries = deps.localErrorMaxRetries ?? OUTPUT_SAFETY_LOCAL_ERROR_MAX_RETRIES;
        this.retryDelay = deps.retryDelay ?? defaultOutputSafetyLocalErrorRetryDelay;
    }
    async pushRuntime(event) {
        // 一旦当前 attempt 被阻断（内容拦截）或软停（网络耗尽），后续所有事件都丢弃。
        // host 会负责生成被拦截 / 软停后的 terminal / retry 行为，这里不能再放出旧
        // attempt 的残留事件。
        if (this.blocked)
            return;
        if (this.networkStopped) {
            // The soft-stop normally drops every residual producer event. A FAILED
            // terminal is different: it records that the runner itself failed, so it
            // must remain authoritative over the host's synthetic network COMPLETED.
            if (event.type === RuntimeEventType.SESSION_STATUS &&
                event.payload?.status === RuntimeEventStatus.FAILED) {
                this.terminalFailed = true;
                await this.inner.pushRuntime(event);
            }
            return;
        }
        // 非 STREAM_RESP 的控制帧不参与浏览器 SSE 的 chunk 顺序，例如 session.status、
        // debug trace、内部 terminal 状态等。它们可以立即透传，否则 abort 后如果还有一个
        // 未达到 threshold 的文本 chunk 卡在队列里，host 可能永远等不到 terminal 状态。
        if (event.type !== RuntimeEventType.STREAM_RESP) {
            await this.inner.pushRuntime(event);
            return;
        }
        const resp = parseStreamResp(event);
        if (!resp) {
            // 解析不了的 stream_resp 没有可审核文本，但仍是 SSE 顺序的一部分；
            // 标记为 ready 并交给统一队列决定何时真正释放。
            await this.enqueueReady(event);
            return;
        }
        if (resp.type === RespDataType.AgentMessageChunk && resp.agent_message_chunk) {
            const chunk = resp.agent_message_chunk;
            if (typeof chunk.msg_id === 'string' && chunk.msg_id)
                this.approvedMsgId = chunk.msg_id;
            if (chunk.thinking_content) {
                // thinking 文本先入队但不可释放；只有覆盖它的 thinking 审核窗口通过后，
                // `releaseWindow` 才会把这些 pending 事件翻成 releasable。
                const pending = this.enqueuePending(event);
                this.thinkingWindow.push(pending);
                this.thinkingText += chunk.thinking_content;
                if (this.thinkingText.length >= this.threshold) {
                    await this.flushStreamingWindow('thinking');
                }
                return;
            }
            if (chunk.msg_content) {
                // agent-core 保证 thinking 一旦切到正文就不可逆；首个正文 chunk 就是
                // thinking phase 的边界。先结算未达到 threshold 的 thinking 尾窗，避免
                // 已通过审核的正文被一个短 thinking 前缀一直卡到 final 才能流出。
                if (!(await this.flushStreamingWindow('thinking')))
                    return;
                // 正文文本和 thinking 类似，但使用 StreamChunk 场景做滑动窗口审核。
                // 这里不能直接 appendEvents，否则安全审核和 producer 顺序都会失控。
                const pending = this.enqueuePending(event);
                this.contentWindow.push(pending);
                this.contentText += chunk.msg_content;
                if (this.contentText.length >= this.threshold) {
                    await this.flushStreamingWindow('content');
                }
                return;
            }
            // 无文本 chunk（常见是 tool-call delta、finish delta）不需要内容审核。
            // finish 对应 producer 的 message_end；首个 tool-call 对没有先行 finish 的
            // producer 也是 phase 边界。二者都必须先结算短 thinking/content 尾窗，不能
            // 等完整 AgentMessage（带 tool 时它要到 tool_execution_end 才会到达）。
            if (chunk.finish === true || (chunk.tool_calls?.length ?? 0) > 0) {
                if (!(await this.flushStreamingWindows()))
                    return;
            }
            // 边界结算通过后才把当前 ready frame 入队；review 拒绝或 network soft-stop
            // 时 helper 已清空 pendingQueue，因此这里直接 return，不可能越过未过审文本。
            await this.enqueueReady(event);
            return;
        }
        if (resp.type === RespDataType.AgentMessage && resp.agent_message) {
            // Final complete message 是本轮 agent 输出的完整形态。
            //
            // 滑动窗口只保证“窗口内”安全，可能漏掉跨窗口组合出来的问题；因此 final 到来时
            // 会用完整 thinking/content 再各审一次。只有 final 审核通过，仍 held 的 chunk
            // 和 final event 才会按 pendingQueue 的原顺序释放给上游 SSE。
            const message = resp.agent_message;
            if (typeof message.msg_id === 'string' && message.msg_id)
                this.approvedMsgId = message.msg_id;
            if (!(await this.reviewFinalWindow(message.thinking_content, this.thinkingText, SAFETY_SCENE.ThinkingContent))) {
                return;
            }
            // final thinking 审的是完整 thinking（reviewFinalWindow 优先用 completeText）。
            // 因此这里直接 SET 为完整文本，避免与流式滑窗累加重复；final 没带完整文本时
            // 退回累加尾窗。若随后 content 审核软停，approvedThinking 已是完整 thinking。
            this.approvedThinking =
                message.thinking_content && message.thinking_content.length > 0
                    ? message.thinking_content
                    : this.approvedThinking + this.thinkingText;
            this.releaseWindow(this.thinkingWindow);
            this.thinkingText = '';
            await this.flushReady();
            if (!(await this.reviewFinalWindow(message.msg_content, this.contentText, SAFETY_SCENE.MessageOutput))) {
                return;
            }
            this.approvedContent =
                message.msg_content && message.msg_content.length > 0
                    ? message.msg_content
                    : this.approvedContent + this.contentText;
            this.releaseWindow(this.contentWindow);
            this.contentText = '';
            await this.enqueueReady(event);
            return;
        }
        // 其它没有 message payload 的 STREAM_RESP 同样没有可审核文本，但它们仍然走队列，
        // 保持与前后 chunk 的 producer 顺序一致。
        await this.enqueueReady(event);
    }
    async appendEvents(events) {
        for (const event of events)
            await this.pushRuntime(event);
    }
    /**
     * Only approved windows (including api_error degradation) may be released.
     * Guide retains a model-only prompt but aborts and drops this attempt just
     * like Reject. Transport failures retry the same text, then soft-stop.
     */
    async review(text, scene) {
        if (!text.trim())
            return true;
        const metrics = this.deps.metricsClient;
        let retryScene = scene;
        // 1 initial call + up to localErrorMaxRetries re-submissions of the SAME text.
        for (let attempt = 0; attempt <= this.localErrorMaxRetries; attempt += 1) {
            if (this.blocked || this.networkStopped)
                return false;
            const startMs = Date.now();
            const result = await this.deps.checkText(text, retryScene);
            // A concurrent input verdict may have retired this attempt while review was pending.
            if (this.blocked || this.networkStopped)
                return false;
            metrics?.histogram('output_safety_check_duration_ms', Date.now() - startMs);
            if (result.errorKind === 'local_error') {
                if (result.retryWithV2 && retryScene === SAFETY_SCENE.StreamChunk) {
                    retryScene = SAFETY_SCENE.MessageOutput;
                }
                metrics?.counter('output_safety_error_total', 1, { errorKind: 'local_error' });
                // 网络/接口故障：不是内容裁定。还有重试预算就等一个 0~5s 随机退避后重试
                // 同一段文本（抖动避免瞬时不可达时打爆网关，也错开并发 turn）。
                if (attempt < this.localErrorMaxRetries) {
                    metrics?.counter('output_safety_check_total', 1, { decision: 'local_error' });
                    await this.retryDelay();
                    continue;
                }
                // 重试耗尽仍无裁定：软停，保留已过审内容，不撤回。
                metrics?.counter('output_safety_check_total', 1, { decision: 'soft_stop_network' });
                await this.softStopNetwork();
                return false;
            }
            if (result.errorKind === 'api_error') {
                metrics?.counter('output_safety_error_total', 1, { errorKind: 'api_error' });
            }
            // 拿到了确定裁定（rejected / api_error / pass）：走共享 fail policy。
            // rejected fail-closed（撤回+重生成），api_error 降级放行。
            if (reviewBlocks(result)) {
                if (result.action === 'reject' || result.errorKind === 'auth_error') {
                    this.immediateBlock = true;
                    this.block();
                    return false;
                }
                // Preserve the guide for the next attempt without releasing this draft.
                if (result.action === 'guide' &&
                    typeof result.guide_prompt === 'string' &&
                    result.guide_prompt.trim()) {
                    this.v2GuideState.mark(result.guide_prompt);
                    metrics?.counter('output_safety_check_total', 1, { decision: 'guide_review' });
                    this.block();
                    return false;
                }
                metrics?.counter('output_safety_check_total', 1, { decision: 'block' });
                metrics?.counter('output_safety_block_total', 1);
                this.block();
                return false;
            }
            metrics?.counter('output_safety_check_total', 1, { decision: 'pass' });
            return true;
        }
        // 循环理论上不会走到这里（上面每条分支都 return），兜底按软停处理。
        await this.softStopNetwork();
        return false;
    }
    /**
     * 标记当前 attempt 被阻断。
     *
     * 这里做三件事：设置 `blocked` 让后续 `pushRuntime` 全部静默丢弃；清空所有尚未
     * 透传的 pending 内容（可能含被拒文本，不能再 flush）；调用 `onBlocked` 由 host
     * abort 仍在生成的 agent-core turn。本类输出审核与 host 的异步输入审核拒绝都会
     * 调它，两种情况都要求「当前 attempt 从此不再往 UI 泄露任何东西」。
     */
    block() {
        if (this.blocked)
            return;
        this.blocked = true;
        // 丢掉尚未透传的内容；它们可能包含被拒绝文本，因此不能留给后续 flush。
        this.pendingQueue.length = 0;
        this.thinkingWindow.length = 0;
        this.contentWindow.length = 0;
        this.thinkingText = '';
        this.contentText = '';
        this.deps.onBlocked?.();
    }
    /**
     * 软停当前 attempt —— 输出安审接口 `local_error` 重试耗尽后调用。
     *
     * 与 {@link block} 的差别只在语义标记（`networkStopped` 而非 `blocked`），
     * 从而让 host 走「保留已过审 + 网络提示 + 不撤回用户输入」而非「撤回 + 重生成」。
     * 副作用相同：设 `networkStopped` 静默丢弃后续事件；清空尚未 flush 的 pending
     * 内容（未拿到裁定，不能泄露；已 flush 的过审内容天然保留）；`onBlocked` 让 host
     * abort 仍在生成的 pi turn 结束本轮。
     */
    async softStopNetwork() {
        if (this.blocked || this.networkStopped)
            return;
        this.networkStopped = true;
        // 先把「已过审部分」合成一条 final AgentMessage 透传给 inner sink，触发 host
        // 的 `observeFrame` 落库 —— 本地链路只有 final AgentMessage 事件会持久化 assistant
        // message，软停时原 final 事件走不到 sink，不补发就会让已过审 thinking/content
        // 只剩流式残帧，refetch/rewind 后丢失。没有任何已过审内容时不补发（无可保留）。
        await this.flushApprovedOnNetworkStop();
        // 丢掉尚未透传的、未拿到裁定的内容；已 flush 的过审内容不受影响。
        this.pendingQueue.length = 0;
        this.thinkingWindow.length = 0;
        this.contentWindow.length = 0;
        this.thinkingText = '';
        this.contentText = '';
        this.deps.onBlocked?.();
    }
    /**
     * 软停时补发一条只含已过审 thinking/content 的 final AgentMessage，让持久化链路
     * （observeFrame → upsertDisplayMessage）把已过审部分定稿落库。复用本轮 assistant 的
     * `approvedMsgId`，与已流式显示的 chunk 归并成同一条（同 msg_id upsert）。
     */
    async flushApprovedOnNetworkStop() {
        return flushApprovedOnNetworkStop(this);
    }
    enqueuePending(event) {
        // “Pending” 表示这个事件已经占住了 producer 顺序位置，但还没通过审核。
        const pending = { event, releasable: false };
        this.pendingQueue.push(pending);
        return pending;
    }
    async enqueueReady(event) {
        if (this.blocked || this.networkStopped)
            return;
        // “Ready” 表示这个事件本身无需等待审核或已经安全，但它仍可能被前序 pending 卡住。
        const pending = { event, releasable: true };
        this.pendingQueue.push(pending);
        await this.flushReady();
    }
    /**
     * 结算所有仍未达到 threshold 的流式文本窗口。
     *
     * thinking 必须先于 content：这既保持 producer 顺序，也确保 thinking 拒绝时正文和
     * 当前 finish/tool-call 都不会进入 ready 队列。任一窗口拒绝或网络软停返回 false，
     * 调用方必须停止处理当前 frame。
     */
    async flushStreamingWindows() {
        if (!(await this.flushStreamingWindow('thinking')))
            return false;
        return this.flushStreamingWindow('content');
    }
    /**
     * 审核并释放一个流式窗口；threshold、thinking→content、finish 与 tool-call 边界
     * 共用这条路径，避免各分支分别维护 approved snapshot、窗口引用和 ready 前缀。
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
        await this.flushReady();
        return true;
    }
    releaseWindow(window) {
        // window 里保存的是 pendingQueue 元素的引用；这里翻标记即可，不改变队列顺序。
        for (const pending of window)
            pending.releasable = true;
        window.length = 0;
    }
    async flushReady() {
        if (this.blocked || this.networkStopped)
            return;
        // 只释放队首连续 ready 前缀。这一条就是防乱序的核心约束。
        // 例：text#1 未审核、finish#2 ready，则 finish#2 也必须继续等。
        const batch = [];
        while (this.pendingQueue[0]?.releasable) {
            const next = this.pendingQueue.shift();
            if (next)
                batch.push(next.event);
        }
        if (batch.length > 0)
            await this.inner.appendEvents(batch);
    }
    async reviewFinalWindow(completeText, windowText, scene) {
        // 优先审 agent-core 给出的完整文本；如果 final 里没有带完整文本，则退回当前累计窗口。
        const text = completeText && completeText.length > 0 ? completeText : windowText;
        if (!text)
            return true;
        return this.review(text, scene);
    }
}
//# sourceMappingURL=output-safety-writer.js.map