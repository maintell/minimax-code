/**
 * Outbound RuntimeEvent secret masking —— RuntimeEvent forward 给 archon-server
 * (SessionExchange)之前的脱敏闸口:cloud-runtime 在
 * `CloudSandboxHost.exchangeRuntimeEvents`,cloud-harness-server 在 run 的 session 投影。
 *
 * Policy(对齐 secrets-plan-v0.3 § 2 / § 9):
 *   - **完整消息边界**(D2):只在 SessionExchange forward 这一关替换,不动
 *     SSE delta(没意义,delta 拆字会让 needle 匹配不上),也不动 RuntimeEvent
 *     封套字段(event_id / session_id / runtime_seq 这些不可能包 secret value)。
 *   - **mask 范围**:`STREAM_RESP.payload.stream_resp` 这条 JSON 字符串里嵌着
 *     `RespData.agent_message`(完整 LLM 回复 + tool_calls),是 secret value
 *     最可能被回显的地方。结构:
 *       - `agent_message.msg_content` —— 助手文本回复
 *       - `agent_message.thinking_content` —— 思考链
 *       - `agent_message.tool_calls[].tool_call_args` —— tool 调用入参 JSON
 *       - `agent_message.tool_calls[].tool_call_result_data` —— tool 执行结果 JSON
 *     `agent_message_chunk` 是 chunk-level wire,也走同样字段集(`msg_content` /
 *     `thinking_content` / `tool_calls[]`),复用同一替换逻辑。
 *   - 其他 RuntimeEventType(SESSION_STATUS / MESSAGE_PERSISTED / DEBUG_TRACE /
 *     ACTION_REQUIRED)payload 形态里没有 LLM 回显出来的 secret value 字段 ——
 *     SESSION_STATUS 的 stop_reason / error 字段带的是 daemon code + 简短 message,
 *     这些来自 cloud-runtime 自己拼接的
 *     payload(不是 LLM 输出),不需要 mask。
 *
 * 注意:本函数对原 event 是 **immutable** 的 —— 返回新对象不改入参。upstream
 * EventReporter / 任何引用持有原 event 的代码(message persistence / debug
 * trace)不会受 mask 影响,只有 forward 给 archon-server 的那份带占位符。
 *
 * 短路:`masker.isEmpty` 时直接返原 event,零分配。
 */
import { RuntimeEventType } from '@mavis/protocol';
export function maskOutboundRuntimeEvent(event, masker) {
    if (masker.isEmpty)
        return event;
    if (event.type !== RuntimeEventType.STREAM_RESP)
        return event;
    const streamResp = event.payload?.stream_resp;
    if (typeof streamResp !== 'string' || streamResp.length === 0)
        return event;
    // archon-server / agent-core 双方都把 stream_resp 当 JSON 字符串(IRespData
    // 序列化),非合法 JSON 就是上游 bug —— mask 不静默掩盖,保留原 event 让
    // 调用方(archon-server forward / 日志)看到。
    let parsed;
    try {
        parsed = JSON.parse(streamResp);
    }
    catch {
        return event;
    }
    const original = parsed;
    const masked = maskRespData(parsed, masker);
    if (masked === original)
        return event;
    return {
        ...event,
        payload: { ...event.payload, stream_resp: JSON.stringify(masked) },
    };
}
function maskRespData(data, masker) {
    const next = { ...data };
    let mutated = false;
    if (data.agent_message) {
        const maskedMsg = maskAgentMessage(data.agent_message, masker);
        if (maskedMsg !== data.agent_message) {
            next.agent_message = maskedMsg;
            mutated = true;
        }
    }
    if (data.agent_message_chunk) {
        const maskedChunk = maskAgentMessage(data.agent_message_chunk, masker);
        if (maskedChunk !== data.agent_message_chunk) {
            next.agent_message_chunk = maskedChunk;
            mutated = true;
        }
    }
    return mutated ? next : data;
}
function maskAgentMessage(msg, masker) {
    const next = { ...msg };
    let mutated = false;
    if (typeof msg.msg_content === 'string') {
        const m = masker.apply(msg.msg_content);
        if (m !== msg.msg_content) {
            next.msg_content = m;
            mutated = true;
        }
    }
    if (typeof msg.thinking_content === 'string') {
        const m = masker.apply(msg.thinking_content);
        if (m !== msg.thinking_content) {
            next.thinking_content = m;
            mutated = true;
        }
    }
    if (Array.isArray(msg.tool_calls)) {
        let toolMutated = false;
        const nextCalls = msg.tool_calls.map((call) => {
            const masked = maskToolCall(call, masker);
            if (masked !== call)
                toolMutated = true;
            return masked;
        });
        if (toolMutated) {
            next.tool_calls = nextCalls;
            mutated = true;
        }
    }
    return mutated ? next : msg;
}
function maskToolCall(call, masker) {
    const next = { ...call };
    let mutated = false;
    if (typeof call.tool_call_args === 'string') {
        const m = masker.applyJson(call.tool_call_args);
        if (m !== call.tool_call_args) {
            next.tool_call_args = m;
            mutated = true;
        }
    }
    if (typeof call.tool_call_result_data === 'string') {
        const m = masker.applyJson(call.tool_call_result_data);
        if (m !== call.tool_call_result_data) {
            next.tool_call_result_data = m;
            mutated = true;
        }
    }
    return mutated ? next : call;
}
//# sourceMappingURL=secret-mask-outbound.js.map