import { RespDataType } from '@mavis/agent-core/protocol/agent-message';
import { RuntimeEventType } from '@mavis/protocol';
/**
 * 软停时补发一条只含已过审 thinking/content 的 final AgentMessage，让持久化链路
 * （observeFrame → upsertDisplayMessage）把已过审部分定稿落库。复用本轮 assistant 的
 * `approvedMsgId`，与已流式显示的 chunk 归并成同一条（同 msg_id upsert）。
 *
 * 拆到独立文件是为了让 `output-safety-writer.ts` 主文件行数压到 layout gate
 * 默认 500 行预算内（见 `scripts/check-local-runtime-layout.mjs`）。
 */
export async function flushApprovedOnNetworkStop(writer) {
    // helper 是 writer 的内部 API,通过结构化类型 cast 访问私有状态。
    // 替代方案是给 writer 加 public getter(暴露内部状态,反而扩大 coupling)。
    const internal = writer;
    // 后台/headless 整轮重投，落库半截已过审会残留成重复/陈旧片段，故关掉合成 final 持久化。
    if (internal.deps.persistApprovedPartialOnNetworkStop === false)
        return;
    if (!internal.approvedThinking && !internal.approvedContent)
        return;
    if (!internal.approvedMsgId)
        return;
    const message = {
        msg_id: internal.approvedMsgId,
        role: 'assistant',
        ...(internal.approvedThinking ? { thinking_content: internal.approvedThinking } : {}),
        // final message 的 msg_content 缺省会被下游当作"无正文"；软停保留 thinking-only
        // 时给空串，保证是一条正常终态 assistant message 而非 error/占位。
        msg_content: internal.approvedContent,
    };
    const event = {
        schema: 'runtime.event/v1',
        event_id: `local-output-network-stop-approved-${internal.approvedMsgId}`,
        type: RuntimeEventType.STREAM_RESP,
        payload: {
            stream_resp: JSON.stringify({
                type: RespDataType.AgentMessage,
                agent_message: message,
            }),
        },
    };
    await internal.inner.pushRuntime(event);
}
//# sourceMappingURL=output-safety-flush-approved.js.map