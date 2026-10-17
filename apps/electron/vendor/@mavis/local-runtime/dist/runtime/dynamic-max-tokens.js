import { streamSimple } from '@earendil-works/pi-ai';
import { LLM_RETRY_CALL_IDENTITY } from '@mavis/agent-core/pi-turn-runner';
import { estimateMessagesTokens, estimateSystemPromptAndToolTokens, } from '../context/token-estimator.js';
/**
 * 动态 per-call maxTokens 钳制（仅 local-runtime，仅 Messages-compatible API）。
 *
 * 问题：配置了超大 max_tokens（如 128k）的模型，静态地把它塞进每个请求
 * 有两个后果——
 *  1. Provider 要求 `input_tokens + max_tokens ≤ contextWindow`，上下文
 *     一长请求本身就是非法的（400 overflow）；
 *  2. 自动压缩触发线按满额 maxTokens 预留，200k 窗口被压到 ~35% 就开始
 *     压缩，浪费大半个窗口。
 *
 * 方案：会话早期给满配置额度，随上下文增长每次调用动态缩减输出预算，
 * 直到 {@link DYNAMIC_MAX_TOKENS_FLOOR}（16k）地板；触发线只需为地板留量
 * （见 lifecycle.ts 的 evaluateTrigger），越过地板线的下一轮自然触发压缩。
 *
 *   effectiveMax = clamp(contextWindow − 估算上下文 − margin, 地板, 配置值)
 *
 * 只在 Messages-compatible API 上启用：其他 provider 的请求不经过这层钳制，
 * 触发线也维持按满额 maxTokens 预留的旧公式，两边始终自洽。
 */
/** 输出预算地板：钳到这个值以下就该压缩了，而不是继续缩输出。 */
export const DYNAMIC_MAX_TOKENS_FLOOR = 16_384;
/** 估算误差的安全边际（与压缩触发线的 safetyMarginTokens 同值同义）。 */
export const DYNAMIC_MAX_TOKENS_SAFETY_MARGIN = 2_048;
/** 正常钳制路径保留的最小可用输出。 */
const MIN_OUTPUT_TOKENS = 1_024;
/** 估算异常时使用 provider 允许的最小正整数预算。 */
const EMERGENCY_OUTPUT_TOKENS = 1;
/**
 * pi-ai 的默认 thinking budget（provider/simple-options.js 的
 * `adjustMaxTokensForThinking`）。它会把 budget 加回 caller 传入的
 * maxTokens 上，所以钳制时必须预扣同样的量 —— 修改此表前先与 pi-ai
 * 版本对齐。xhigh/max 在 pi 侧被 clamp 成 high。
 */
const PI_DEFAULT_THINKING_BUDGETS = {
    minimal: 1_024,
    low: 2_048,
    medium: 8_192,
    high: 16_384,
};
/**
 * 连接异步 context lifecycle checkpoint 和同步 StreamFn wrapper。
 * `count_tokens` 在 `beforeLlmCall` 阶段执行；真正 provider stream
 * 随后必须同步返回 event stream，所以 wrapper 只能消费已经算好的快照，
 * 不能在这里 await remote counter。
 */
export class LocalDynamicMaxTokensState {
    snapshots = new Map();
    setRemoteContextTokens(sessionId, tokens) {
        if (!sessionId || !Number.isFinite(tokens) || tokens <= 0) {
            this.clear(sessionId);
            return;
        }
        this.snapshots.set(sessionId, { tokens, source: 'remote_count_tokens' });
    }
    clear(sessionId) {
        if (!sessionId)
            return;
        this.snapshots.delete(sessionId);
    }
    get(sessionId) {
        if (!sessionId)
            return undefined;
        return this.snapshots.get(sessionId);
    }
    /**
     * snapshot 只用一次：它描述的是最近一次 checkpoint 数过的精确 provider
     * payload。后续 provider call 如果复用旧 snapshot，就会拿另一个 context
     * 的 stale input tokens 来钳制预算。
     */
    consume(sessionId) {
        if (!sessionId)
            return undefined;
        const snapshot = this.snapshots.get(sessionId);
        this.snapshots.delete(sessionId);
        return snapshot;
    }
}
/**
 * 纯函数：给定窗口/配置额度/当前上下文估算，算出本次调用的输出预算。
 * 窗口或配置额度未知时不钳（原样返回配置值）；配置额度本身小于地板时
 * 也不放大（只缩不涨）。
 */
export function resolveDynamicMaxTokens(input) {
    const { contextWindow, configuredMaxTokens, estimatedContextTokens } = input;
    if (!(contextWindow > 0) || !(configuredMaxTokens > 0))
        return configuredMaxTokens;
    const remaining = contextWindow - estimatedContextTokens - DYNAMIC_MAX_TOKENS_SAFETY_MARGIN;
    const floor = Math.min(configuredMaxTokens, DYNAMIC_MAX_TOKENS_FLOOR);
    return Math.min(configuredMaxTokens, Math.max(floor, remaining));
}
/**
 * 估算 pi-ai `Context`（system prompt、messages、tools）的 token 足迹。
 * 这里只作为没有 remote snapshot 时的同步兜底。使用有超长连续文本保护的
 * 本地 estimator 估算当前完整 payload，不复用无法和当前 system prompt、tools
 * 绑定的历史 usage，避免外部 payload 变化时漏算或未变化时重复计算。
 */
export function estimatePiContextTokens(context, _model) {
    return (estimateMessagesTokens((context.messages ?? [])) +
        estimateSystemPromptAndToolTokens(context.systemPrompt, context.tools));
}
/**
 * budget 思考模式下 pi-ai 会把 thinking budget 加回 caller cap
 * （adjustMaxTokensForThinking：`maxTokens = min(caller + budget, model上限)`），
 * 钳制值必须预扣同样的量，最终请求才不会超出 remaining。adaptive 思考
 * （forceAdaptiveThinking）走 effort 参数、不动 maxTokens，无需预扣。
 */
function thinkingBudgetTokens(model, options) {
    const reasoning = options?.reasoning;
    if (!reasoning)
        return 0;
    if (model.compat?.forceAdaptiveThinking) {
        return 0;
    }
    const level = reasoning === 'xhigh' || reasoning === 'max' ? 'high' : reasoning;
    return options?.thinkingBudgets?.[level] ?? PI_DEFAULT_THINKING_BUDGETS[level] ?? 0;
}
/**
 * StreamFn 包装器：作为 resolver 产出的最内层 streamFn，每次 provider call
 * 拿到完整 context 后按剩余窗口钳制 `options.maxTokens`。外层
 * composeStreamFn 的 withMaxTokens 已把配置额度填进 options，这里只缩不涨；
 * 未钳制（额度仍放得下）时请求原样透传。
 */
export function withLocalDynamicMaxTokens(inner, state, sessionId) {
    const base = inner ?? streamSimple;
    const retryBudgets = new WeakMap();
    return ((model, context, options) => {
        if (model.api !== 'anthropic-messages')
            return base(model, context, options);
        const contextWindow = typeof model.contextWindow === 'number' ? model.contextWindow : 0;
        const optionMaxTokens = options?.maxTokens;
        const configured = typeof optionMaxTokens === 'number' && optionMaxTokens > 0
            ? optionMaxTokens
            : model.maxTokens;
        if (!(contextWindow > 0) || !(configured > 0))
            return base(model, context, options);
        const retryCallIdentity = options?.[LLM_RETRY_CALL_IDENTITY];
        const retryBudget = retryCallIdentity ? retryBudgets.get(retryCallIdentity) : undefined;
        if (retryBudget !== undefined) {
            return base(model, context, {
                ...(options ?? {}),
                maxTokens: retryBudget.maxTokens,
                ...(retryBudget.disableReasoning ? { reasoning: undefined } : {}),
            });
        }
        const runtimeSessionId = sessionId ?? options?.sessionId;
        const remoteSnapshot = state?.consume(runtimeSessionId);
        // 优先使用同一次 checkpoint 得到的 provider input tokens。本地 estimate
        // 只作为无 snapshot 时的同步兜底；若兜底本身异常，降到 provider
        // 允许的最小预算并关闭 reasoning，避免 thinking budget 被重新加回。
        let contextTokens;
        try {
            contextTokens = remoteSnapshot?.tokens ?? estimatePiContextTokens(context, model);
        }
        catch {
            if (retryCallIdentity) {
                retryBudgets.set(retryCallIdentity, {
                    maxTokens: EMERGENCY_OUTPUT_TOKENS,
                    disableReasoning: true,
                });
            }
            return base(model, context, {
                ...(options ?? {}),
                maxTokens: EMERGENCY_OUTPUT_TOKENS,
                reasoning: undefined,
            });
        }
        const desired = resolveDynamicMaxTokens({
            contextWindow,
            configuredMaxTokens: configured,
            estimatedContextTokens: contextTokens,
        });
        if (desired >= configured) {
            if (retryCallIdentity) {
                retryBudgets.set(retryCallIdentity, {
                    maxTokens: configured,
                    disableReasoning: false,
                });
            }
            return base(model, context, options);
        }
        const clamped = Math.max(MIN_OUTPUT_TOKENS, desired -
            thinkingBudgetTokens(model, options));
        if (retryCallIdentity) {
            retryBudgets.set(retryCallIdentity, {
                maxTokens: clamped,
                disableReasoning: false,
            });
        }
        return base(model, context, { ...(options ?? {}), maxTokens: clamped });
    });
}
//# sourceMappingURL=dynamic-max-tokens.js.map