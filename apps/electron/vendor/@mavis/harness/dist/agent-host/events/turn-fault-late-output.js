/** The tool call the late output of a released `hold-ignore-abort` rule carries. */
const LATE_TOOL_NAME = 'turn_fault_late';
/**
 * Verification-only (Bunny context reset S03, S08): what a Turn writes after
 * a `hold-ignore-abort` turn fault is released, on the Turn's own history
 * path, as model output would arrive: an assistant message with `lateText` and
 * one tool call, then that call's result. A Turn ended by force has these
 * writes dropped; any other Turn writes them as it would.
 */
export async function writeTurnFaultLateOutput(input, lateText) {
    const { sessionId, turnId } = input.lease;
    const model = input.preparation.llm.model;
    const timestamp = Date.now();
    const toolCallId = `${LATE_TOOL_NAME}_${turnId}`;
    const assistant = {
        role: 'assistant',
        content: [
            { type: 'text', text: lateText },
            { type: 'toolCall', id: toolCallId, name: LATE_TOOL_NAME, arguments: {} },
        ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'toolUse',
        timestamp,
    };
    const toolResult = {
        role: 'toolResult',
        toolCallId,
        toolName: LATE_TOOL_NAME,
        content: [{ type: 'text', text: `${lateText} tool result` }],
        isError: false,
        timestamp,
    };
    await input.onHistoryChanged({
        sessionId,
        turnId,
        reason: 'messageDelta',
        messages: [assistant, toolResult],
    });
}
//# sourceMappingURL=turn-fault-late-output.js.map