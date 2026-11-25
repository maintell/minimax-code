import { Agent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, } from '@earendil-works/pi-ai';
import { convertToLlm } from '@earendil-works/pi-coding-agent';
import { callMemoryModel } from './observed-call.js';
import { TRUNCATED_TOOL_CALL_MESSAGE, TRUNCATED_TURN_MESSAGE } from './tool-loop.js';
/** 压缩后补回的接续说明：没有检查点，工作目录里的两份草稿就是已完成的进度。 */
const RESUME_AFTER_COMPACTION = '工作目录中的 MEMORY.md 与 memory_summary.md 草稿就是已完成的进度，继续编辑即可。';
class ConsolidationBudgetExceeded extends Error {
    constructor() {
        super('agent-limit-exceeded');
    }
}
/**
 * 整理用独立 Pi Agent（§5.6）：只装配整理工具，上下文接近窗口时按 Runtime 的压缩算法压缩，
 * 之后继续编辑同一工作目录。模型回复不再调用工具即结束，编辑效果以工作目录内容为准。
 * 物理请求数（含压缩请求与上游重试）达到 maxRequests 时返回 agent-limit-exceeded；
 * 模型错误以异常抛出，由 ModelGateway 统一分类。
 */
export async function runConsolidationAgent(input) {
    const { request, nowMs } = input;
    const initial = await input.resolve();
    let requests = 0;
    let budgetExceeded = false;
    let failure;
    let hasNextTurn = false;
    // 预算按物理请求计：每次真实发出请求前登记，超过上限即拒绝发出。
    const observer = {
        started: (call) => {
            if (requests >= request.maxRequests) {
                budgetExceeded = true;
                throw new ConsolidationBudgetExceeded();
            }
            requests++;
            return input.modelCalls?.started(call) ?? String(requests);
        },
        finished: (id, result) => input.modelCalls?.finished(id, result),
    };
    const stream = async (_model, context, options) => {
        request.signal.throwIfAborted();
        const { resolved, stream: upstream } = await input.resolve();
        const output = createAssistantMessageEventStream();
        let terminal;
        try {
            input.diagnosticEvent?.('llm.request', {
                kind: request.kind,
                model: request.modelName,
                systemPrompt: context.systemPrompt,
                messages: context.messages,
                tools: context.tools,
            });
            const response = await callMemoryModel({
                resolved,
                stream: upstream,
                context,
                options,
                modelCalls: observer,
                reasoningEffort: request.reasoningEffort,
                maxTokens: options?.maxTokens ?? request.maxOutputTokens,
                signal: request.signal,
                nowMs,
                consume: async (source) => {
                    for await (const event of source) {
                        if (event.type === 'done' || event.type === 'error')
                            terminal = event;
                        else
                            output.push(event);
                    }
                    return source.result();
                },
            });
            failure = undefined;
            input.diagnosticEvent?.('llm.response', { kind: request.kind, response });
            input.diagnosticEvent?.('llm.usage', { usage: response.usage });
            if (terminal)
                output.push(terminal);
            output.end(response);
        }
        catch (error) {
            failure = error;
            const response = failedResponse(resolved, error, nowMs());
            output.push({ type: 'error', reason: 'error', error: response });
            output.end(response);
        }
        return output;
    };
    const compact = input.createContextCompactor(() => ({
        role: 'user',
        timestamp: nowMs(),
        content: `${request.briefing}\n\n${RESUME_AFTER_COMPACTION}`,
    }));
    const agent = new Agent({
        initialState: {
            systemPrompt: request.systemPrompt,
            model: initial.resolved.model,
            thinkingLevel: request.reasoningEffort,
            tools: request.tools.map((tool) => ({
                name: tool.name,
                label: tool.name,
                description: tool.description,
                parameters: tool.parameters,
                executionMode: 'sequential',
                execute: async (_id, args) => {
                    request.signal.throwIfAborted();
                    input.diagnosticEvent?.('tool.request', { name: tool.name, arguments: args });
                    const result = await tool.execute(args);
                    input.diagnosticEvent?.('tool.response', { name: tool.name, result });
                    return {
                        content: [{ type: 'text', text: result.text }],
                        details: {},
                        isError: result.isError,
                    };
                },
            })),
        },
        convertToLlm,
        streamFn: stream,
        toolExecution: 'sequential',
        // 输出撞上长度上限时，工具调用参数已被截断，执行它只会写入残缺内容。
        beforeToolCall: async ({ assistantMessage }) => assistantMessage.stopReason === 'length'
            ? { block: true, reason: TRUNCATED_TOOL_CALL_MESSAGE }
            : undefined,
        shouldStopAfterTurn: () => budgetExceeded,
        // 只在还有下一轮时压缩，最终回复之后不再花一次请求。
        prepareNextTurn: async () => {
            if (budgetExceeded || !hasNextTurn)
                return undefined;
            const result = await compact({
                messages: agent.state.messages,
                model: initial.resolved.model,
                streamFn: stream,
                systemPrompt: request.systemPrompt,
                tools: [...request.tools],
                thinkingLevel: request.reasoningEffort,
                maxTokens: request.maxOutputTokens,
                signal: request.signal,
            });
            if (!result)
                return undefined;
            input.diagnosticEvent?.('context.compacted', {
                before: agent.state.messages.length,
                after: result.length,
            });
            const replacement = [...result];
            agent.state.messages = replacement;
            return {
                context: {
                    systemPrompt: request.systemPrompt,
                    messages: replacement,
                    tools: agent.state.tools,
                },
            };
        },
    });
    const abort = () => agent.abort();
    agent.subscribe((event) => {
        if (event.type !== 'turn_end')
            return;
        const truncated = event.message.role === 'assistant' && event.message.stopReason === 'length';
        hasNextTurn = event.toolResults.length > 0 || truncated;
        // 回复没有任何工具调用就被截断时只是没写完，回填提示继续，不当成完成。
        if (truncated &&
            event.message.role === 'assistant' &&
            !event.message.content.some((part) => part.type === 'toolCall')) {
            agent.followUp({ role: 'user', timestamp: nowMs(), content: TRUNCATED_TURN_MESSAGE });
        }
    });
    request.signal.addEventListener('abort', abort, { once: true });
    try {
        await agent.prompt(request.briefing);
        if (budgetExceeded)
            return { status: 'agent-limit-exceeded' };
        if (agent.state.errorMessage)
            throw failure ?? new Error(agent.state.errorMessage);
        request.signal.throwIfAborted();
        return { status: 'completed' };
    }
    catch (error) {
        if (budgetExceeded)
            return { status: 'agent-limit-exceeded' };
        throw error;
    }
    finally {
        request.signal.removeEventListener('abort', abort);
    }
}
function failedResponse(resolved, error, timestamp) {
    return {
        role: 'assistant',
        content: [],
        api: resolved.model.api,
        provider: resolved.model.provider,
        model: resolved.model.id,
        stopReason: 'error',
        errorMessage: error instanceof Error ? error.message : String(error),
        timestamp,
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
    };
}
//# sourceMappingURL=consolidation-agent.js.map