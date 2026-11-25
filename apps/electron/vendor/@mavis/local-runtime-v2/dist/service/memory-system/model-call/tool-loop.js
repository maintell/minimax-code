import { callMemoryModel } from './observed-call.js';
/**
 * Memory V2 Stage Two 的多轮工具循环（§5.6）：驱动模型在调用方给定的工具边界
 * 内自主编辑，直到模型不再发出工具调用（完成）或触达轮次上限。模型错误
 * 以异常抛出，由 ModelGateway 统一分类；编辑效果以工作目录内容为准。
 */
export async function runMemoryToolLoop(input) {
    const { request } = input;
    const tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
    }));
    const messages = [
        { role: 'user', content: request.briefing, timestamp: input.nowMs() },
    ];
    for (let turn = 0; turn < request.maxTurns; turn += 1) {
        // 整轮可持续数十分钟，登录凭证会在期间轮换；每步重新解析，避免沿用过期 token 收到 401。
        const { resolved, stream } = await input.resolve();
        const startedAtMs = input.nowMs();
        input.diagnosticEvent?.('llm.request', {
            kind: request.kind,
            turn: turn + 1,
            model: request.modelName,
            reasoningEffort: request.reasoningEffort,
            systemPrompt: request.systemPrompt,
            messages,
            tools,
            maxOutputTokens: request.maxOutputTokens,
        });
        const result = await runMemoryLoopStep({
            stream,
            resolved,
            request,
            messages,
            tools,
            diagnosticEvent: input.diagnosticEvent,
            modelCalls: input.modelCalls,
            nowMs: input.nowMs,
        });
        input.diagnosticEvent?.('llm.usage', {
            turn: turn + 1,
            usage: result.usage,
            durationMs: input.nowMs() - startedAtMs,
        });
        messages.push(result);
        const toolCalls = result.content.filter((part) => part.type === 'toolCall');
        if (toolCalls.length === 0) {
            // 完成协议：模型主动停止调用工具才算完成，最终文本不参与结果。撞上输出上限的回复
            // 只是没写完——回填提示后继续下一步，前几步已完成的编辑不作废，也不会把空转当成
            // 完成去发布未改动的产物。用满轮次上限才按 agent-limit-exceeded 失败。
            if (result.stopReason !== 'length')
                return { status: 'completed' };
            messages.push(truncationNudge(input.nowMs));
            continue;
        }
        messages.push(
        // 输出撞上长度上限时，工具调用参数已被截断，执行它只会写入残缺内容。
        ...(result.stopReason === 'length'
            ? rejectTruncatedToolCalls(toolCalls, input.nowMs)
            : await executeMemoryLoopToolCalls(request.tools, toolCalls, input.nowMs, input.diagnosticEvent)));
    }
    return { status: 'agent-limit-exceeded' };
}
/** 单步模型调用：终态为 error/aborted 时抛出，交由 ModelGateway 统一分类。 */
async function runMemoryLoopStep(step) {
    const { stream, resolved, request } = step;
    const result = await callMemoryModel({
        resolved,
        stream,
        context: {
            systemPrompt: request.systemPrompt,
            messages: [...step.messages],
            tools: [...step.tools],
        },
        modelCalls: step.modelCalls,
        reasoningEffort: request.reasoningEffort,
        maxTokens: request.maxOutputTokens,
        nowMs: step.nowMs,
        signal: request.signal,
    });
    step.diagnosticEvent?.('llm.response', { kind: request.kind, response: result });
    if (result.stopReason === 'error' || result.stopReason === 'aborted') {
        throw new Error(result.errorMessage ?? `Memory model ${result.stopReason}`);
    }
    return result;
}
export const TRUNCATED_TOOL_CALL_MESSAGE = 'The response reached the output token limit, so this tool call was cut off and not executed. ' +
    'Retry with smaller calls: split large content across several calls.';
export const TRUNCATED_TURN_MESSAGE = 'The previous reply reached the output token limit before any tool call, so nothing was applied. ' +
    'Continue directly with tool calls and split large content across several calls.';
/** 整步没有任何工具调用就被截断时的回填提示；模型据此在下一步继续编辑。 */
function truncationNudge(nowMs) {
    return {
        role: 'user',
        content: TRUNCATED_TURN_MESSAGE,
        timestamp: nowMs(),
    };
}
/** 响应被长度截断时不执行任何调用，统一回填可重试的错误，引导模型拆分输出。 */
function rejectTruncatedToolCalls(toolCalls, nowMs) {
    return toolCalls.map((call) => ({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: TRUNCATED_TOOL_CALL_MESSAGE }],
        isError: true,
        timestamp: nowMs(),
    }));
}
/** 逐个执行工具调用并构造 toolResult 消息；未知工具与执行异常都以错误结果回填。 */
async function executeMemoryLoopToolCalls(tools, toolCalls, nowMs, diagnosticEvent) {
    const results = [];
    for (const call of toolCalls) {
        const startedAtMs = nowMs();
        diagnosticEvent?.('tool.request', {
            toolCallId: call.id,
            name: call.name,
            arguments: call.arguments,
        });
        const tool = tools.find((candidate) => candidate.name === call.name);
        let outcome;
        if (tool) {
            try {
                outcome = await tool.execute(call.arguments ?? {});
            }
            catch (error) {
                outcome = {
                    text: error instanceof Error ? error.message : 'Tool failed.',
                    isError: true,
                };
            }
        }
        else {
            outcome = { text: `Unknown tool: ${call.name}`, isError: true };
        }
        diagnosticEvent?.('tool.response', {
            toolCallId: call.id,
            name: call.name,
            result: outcome,
            durationMs: nowMs() - startedAtMs,
        });
        results.push({
            role: 'toolResult',
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: 'text', text: outcome.text }],
            isError: outcome.isError === true,
            timestamp: nowMs(),
        });
    }
    return results;
}
//# sourceMappingURL=tool-loop.js.map