import { randomUUID } from 'node:crypto';
import { withLLMRetry } from '@mavis/agent-core/pi-turn-runner';
import { streamSimple } from '@earendil-works/pi-ai';
import { ThinkingLevel } from '@mavis/protocol';
import { parseMemoryModelOverride } from './model-override.js';
import { readMemorySubmission } from './submission.js';
import { callMemoryModel } from './observed-call.js';
import { runConsolidationAgent } from './consolidation-agent.js';
import { runMemoryToolLoop } from './tool-loop.js';
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
    const resolve = async (reasoningEffort, modelNameOverride, toolLoop = false) => {
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
        const turnId = `turn_memory_${randomUUID()}`;
        const resolved = await input.preparation.resolveModel({
            sessionId: GLOBAL_MEMORY_MODEL_ANCHOR,
            turnId,
            agentConfig,
        });
        const base = resolved.streamFn ?? streamSimple;
        // 与普通会话一致，传输层失败（过载、5xx、网络、限流）按框架策略退避重发；额度用尽、认证失败等
        // 终止类错误不重试。单 key 的 BYOK 等没有 callLifecycle 的模型以前完全不重试，一次瞬时失败就会
        // 让耗时数十分钟的整理整轮作废。
        const stream = withLLMRetry(base, {
            sessionId: GLOBAL_MEMORY_MODEL_ANCHOR,
            turnId,
            scope: 'memory',
            ...(resolved.callLifecycle ? { lifecycle: resolved.callLifecycle } : {}),
            ...(input.retrySleep ? { sleep: input.retrySleep } : {}),
            // 工具循环与整理 Agent 以不再调用工具的回复结束，这条回复可以没有正文，是完成信号而不是空
            // 回复；按空回复重发只会带着完整上下文白发请求。单次调用没交提交工具时仍按空回复重发。
            ...(toolLoop ? { replyGuard: { emptyRetries: 0 } } : {}),
        });
        return { resolved, stream };
    };
    return {
        async resolveModel(request) {
            const { resolved } = await resolve(request.reasoningEffort, request.modelName);
            // 输出上限取模型自身上限：产物体量由 maxSessionDocBytes、maxMemoryMarkdownBytes 等字节上限
            // 在程序侧约束；再压一层 token 上限，长会话整份重写文档时会被截断。
            const maxOutputTokens = resolved.model.maxTokens;
            // 输出上限按配置可能接近上下文窗口；为输入预算至少留出一半窗口，避免历史被压到不可用。
            const outputReserve = Math.min(maxOutputTokens, Math.floor(resolved.model.contextWindow / 2));
            return {
                modelName: `${resolved.model.provider}/${resolved.model.id}`,
                managedProvider: resolved.managedProvider === true,
                parameters: { reasoning: resolved.thinkingLevel ?? 'off' },
                contextWindow: resolved.model.contextWindow,
                maxInputTokens: Math.max(1, resolved.model.contextWindow - outputReserve),
                maxOutputTokens,
            };
        },
        async complete(request) {
            const { resolved, stream } = await resolve(request.reasoningEffort, request.modelName);
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
            const result = await callMemoryModel({
                resolved,
                stream,
                context: {
                    systemPrompt: request.systemPrompt,
                    ...(request.outputTool ? { tools: [request.outputTool] } : {}),
                    messages: [
                        { role: 'user', content: request.canonicalPayloadJson, timestamp: input.nowMs() },
                    ],
                },
                modelCalls: input.modelCalls,
                reasoningEffort: request.reasoningEffort,
                maxTokens: request.maxOutputTokens,
                nowMs: input.nowMs,
                signal: request.signal,
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
         * 整理走 consolidation-agent.ts 的独立 Agent 与上下文压缩；其余调用方沿用 tool-loop.ts 的
         * 轮次循环。两者都在这里绑定运行时级的模型解析。
         */
        async runToolLoop(request) {
            const shared = {
                resolve: () => resolve(request.reasoningEffort, request.modelName, true),
                nowMs: input.nowMs,
                diagnosticEvent: input.diagnosticEvent,
                modelCalls: input.modelCalls,
            };
            if (request.executionMode !== 'consolidation-agent')
                return runMemoryToolLoop({ ...shared, request });
            if (!input.createContextCompactor)
                throw new Error('memory-context-compactor-missing');
            return runConsolidationAgent({
                ...shared,
                request,
                createContextCompactor: input.createContextCompactor,
            });
        },
    };
}
//# sourceMappingURL=completion.js.map