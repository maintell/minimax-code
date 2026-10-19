import { RespDataType, ToolCallStatus } from '@mavis/agent-core/protocol/agent-message';
export function hasWaitingForUserToolResult(event) {
    const raw = event.payload?.stream_resp;
    if (typeof raw !== 'string' || raw.length === 0)
        return false;
    try {
        const parsed = JSON.parse(raw);
        const toolCalls = parsed.type === RespDataType.AgentMessage
            ? parsed.agent_message?.tool_calls
            : parsed.type === RespDataType.AgentMessageChunk
                ? parsed.agent_message_chunk?.tool_calls
                : undefined;
        if (!Array.isArray(toolCalls))
            return false;
        return toolCalls.some(isWaitingForUserToolCall);
    }
    catch {
        return false;
    }
}
function isWaitingForUserToolCall(toolCall) {
    if (!toolCall || typeof toolCall !== 'object')
        return false;
    const record = toolCall;
    const toolName = typeof record.tool_name === 'string' ? record.tool_name : undefined;
    const isFinished = record.tool_call_status === ToolCallStatus.Finished;
    if (!isFinished)
        return false;
    const rawResult = typeof record.tool_call_result_data === 'string' ? record.tool_call_result_data : undefined;
    if (rawResult) {
        try {
            const result = JSON.parse(rawResult);
            if (result.details?.waiting_for_user === true)
                return true;
            // Decision v3: a suppressed ask_user resolves inline and keeps the turn
            // running; an explicit false opts out of the ask_user fallback below.
            if (result.details?.waiting_for_user === false)
                return false;
            if (toolName === 'ask_user' && result.terminate === true)
                return true;
        }
        catch {
            // Fall through to the ask_user finished check below.
        }
    }
    // LocalAskUserTool always terminates after recording a pending questionnaire.
    // Keep this as a fallback for older result payloads that predate `details`.
    return toolName === 'ask_user';
}
//# sourceMappingURL=waiting-for-user.js.map