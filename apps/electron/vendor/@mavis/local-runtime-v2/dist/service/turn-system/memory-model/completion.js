import { randomUUID } from 'node:crypto';
import { streamSimple } from '@earendil-works/pi-ai';
import { ThinkingLevel } from '@mavis/protocol';
import { parseMemoryModelOverride } from './model-override.js';
import { readMemorySubmission } from './submission.js';
import { observeMemoryModelCall } from './observed-call.js';
/**
 * Synthetic anchor for the runtime-wide memory model resolution. It is never a
 * real Session id: the resolver uses it only for logging and one attribution
 * header, and writes no Session state.
 */
const GLOBAL_MEMORY_MODEL_ANCHOR = 'memory-v2:global-model-anchor';
/**
 * Session-independent auxiliary model call for Memory V2 (§5.4).
 *
 * Memory V2 resolves one model for the whole runtime instead of following each
 * Agent's own model config. `ModelGateway.resolveContract(kind)` carries no
 * Session, and its `contractId` is hashed into every session state row's
 * `capture_contract_id`; a per-Agent model would make that id vary by Agent and
 * keep re-extracting every session captured under a different one.
 *
 * The resolver only reads `agentConfig.model` plus the Agent header id, and it
 * writes no Session state — `sessionId` reaches logging and one attribution
 * header. A synthetic anchor is therefore safe and keeps resolution
 * deterministic, which is what `contractId` stability requires.
 */
export function createGlobalMemoryModelCompletion(input) {
    const resolve = async (reasoningEffort, modelNameOverride) => {
        const modelName = modelNameOverride ?? input.defaultModelName();
        const override = parseMemoryModelOverride(modelName);
        const agentConfig = {
            system_prompt: '',
            model: {
                provider: override.provider_id,
                model_id: override.model_id,
                thinking_level: {
                    low: ThinkingLevel.LOW,
                    medium: ThinkingLevel.MEDIUM,
                    high: ThinkingLevel.HIGH,
                }[reasoningEffort],
                capabilities: { selected_thinking_effort: reasoningEffort },
            },
            tools: [],
            skills: [],
        };
        const resolved = await input.preparation.resolveModel({
            sessionId: GLOBAL_MEMORY_MODEL_ANCHOR,
            turnId: `turn_memory_${randomUUID()}`,
            agentConfig,
        });
        return { resolved };
    };
    return {
        async resolveModel(request) {
            const { resolved } = await resolve(request.reasoningEffort, request.modelName);
            const maxOutputTokens = Math.min(request.kind === 'consolidation' ? 16_384 : 8_192, resolved.model.maxTokens);
            return {
                modelName: `${resolved.model.provider}/${resolved.model.id}`,
                parameters: { reasoning: resolved.thinkingLevel ?? 'off' },
                maxInputTokens: Math.max(1, resolved.model.contextWindow - maxOutputTokens),
                maxOutputTokens,
            };
        },
        async complete(request) {
            const { resolved } = await resolve(request.reasoningEffort, request.modelName);
            const stream = resolved.streamFn ?? streamSimple;
            const startedAtMs = input.nowMs();
            input.diagnosticEvent?.('llm.request', {
                kind: request.kind,
                model: request.modelName,
                reasoningEffort: request.reasoningEffort,
                systemPrompt: request.systemPrompt,
                canonicalPayloadJson: request.canonicalPayloadJson,
                maxOutputTokens: request.maxOutputTokens,
                ...(request.outputTool ? { tools: [request.outputTool] } : {}),
            });
            const result = await observeMemoryModelCall({
                modelCalls: input.modelCalls,
                model: `${resolved.model.provider}/${resolved.model.id}`,
                reasoningEffort: request.reasoningEffort,
                nowMs: input.nowMs,
                signal: request.signal,
            }, async () => {
                const response = await stream(resolved.model, {
                    systemPrompt: request.systemPrompt,
                    ...(request.outputTool ? { tools: [request.outputTool] } : {}),
                    messages: [
                        {
                            role: 'user',
                            content: request.canonicalPayloadJson,
                            timestamp: input.nowMs(),
                        },
                    ],
                }, {
                    ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
                    ...(resolved.headers ? { headers: resolved.headers } : {}),
                    // 推理强度来自记忆配置（设计 §2.3），覆盖会话侧 thinkingLevel。
                    reasoning: request.reasoningEffort,
                    maxTokens: request.maxOutputTokens,
                    signal: request.signal,
                });
                return response.result();
            });
            input.diagnosticEvent?.('llm.response', {
                kind: request.kind,
                response: result,
                durationMs: input.nowMs() - startedAtMs,
            });
            if (result.stopReason === 'error' || result.stopReason === 'aborted') {
                throw new Error(result.errorMessage ?? `Memory model ${result.stopReason}`);
            }
            if (request.outputTool) {
                return readMemorySubmission(result, request.outputTool.name);
            }
            return result.content
                .flatMap((part) => part.type === 'text' && typeof part.text === 'string' ? [part.text] : [])
                .join('')
                .trim();
        },
        /**
         * Memory V2 Stage Two 的多轮工具循环（§5.6）：驱动模型在调用方给定的工具边界
         * 内自主编辑，直到模型不再发出工具调用（完成）或触达轮次上限。模型错误
         * 以异常抛出，由 ModelGateway 统一分类；编辑效果以工作目录内容为准。
         */
        async runToolLoop(request) {
            const { resolved } = await resolve(request.reasoningEffort, request.modelName);
            const stream = resolved.streamFn ?? streamSimple;
            const tools = request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            }));
            const messages = [
                { role: 'user', content: request.briefing, timestamp: input.nowMs() },
            ];
            for (let turn = 0; turn < request.maxTurns; turn += 1) {
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
                // 完成协议：模型不再调用工具即视为完成，最终文本不参与结果。
                if (toolCalls.length === 0)
                    return { status: 'completed' };
                messages.push(...(await executeMemoryLoopToolCalls(request.tools, toolCalls, input.nowMs, input.diagnosticEvent)));
            }
            return { status: 'agent-limit-exceeded' };
        },
    };
}
/** 单步模型调用：终态为 error/aborted 时抛出，交由 ModelGateway 统一分类。 */
async function runMemoryLoopStep(step) {
    const { stream, resolved, request } = step;
    const result = await observeMemoryModelCall({
        modelCalls: step.modelCalls,
        model: `${resolved.model.provider}/${resolved.model.id}`,
        reasoningEffort: request.reasoningEffort,
        nowMs: step.nowMs,
        signal: request.signal,
    }, async () => {
        const response = await stream(resolved.model, {
            systemPrompt: request.systemPrompt,
            messages: [...step.messages],
            tools: [...step.tools],
        }, {
            ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
            ...(resolved.headers ? { headers: resolved.headers } : {}),
            reasoning: request.reasoningEffort,
            maxTokens: request.maxOutputTokens,
            signal: request.signal,
        });
        return response.result();
    });
    step.diagnosticEvent?.('llm.response', { kind: request.kind, response: result });
    if (result.stopReason === 'error' || result.stopReason === 'aborted') {
        throw new Error(result.errorMessage ?? `Memory model ${result.stopReason}`);
    }
    return result;
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
//# sourceMappingURL=completion.js.map