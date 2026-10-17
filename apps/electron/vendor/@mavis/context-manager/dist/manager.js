import { generateSummary } from '@earendil-works/pi-agent-core';
import { computeCompactionTriggerAt, DEFAULT_CONTEXT_MANAGER_SETTINGS } from './settings.js';
import { createDefaultContextTokenEstimator } from './token-estimator.js';
export class ContextManager {
    beforeLlmCall;
    settings;
    tokenEstimator;
    tokenCounter;
    summaryGenerator;
    lock;
    observer;
    nowMs;
    idGenerator;
    constructor(options = {}) {
        this.settings = { ...DEFAULT_CONTEXT_MANAGER_SETTINGS, ...(options.settings ?? {}) };
        this.tokenEstimator = createDefaultContextTokenEstimator();
        this.tokenCounter = options.tokenCounter;
        this.summaryGenerator = options.summaryGenerator;
        this.lock = options.lock ?? new InProcessContextManagerLock();
        this.observer = options.observer;
        this.nowMs = options.nowMs ?? Date.now;
        this.idGenerator = options.idGenerator ?? defaultReplacementId;
        this.beforeLlmCall = (input) => this.checkpoint(input);
    }
    checkpoint(input, options = {}) {
        return this.lock.withSessionLock(input.sessionId, () => this.checkpointLocked(input, options));
    }
    async checkpointLocked(input, options) {
        const activeMessages = [...input.messages];
        const trigger = await this.evaluateTrigger(activeMessages, input);
        await this.notify('onTriggerEvaluated', {
            sessionId: input.sessionId,
            turnId: input.turnId,
            phase: input.phase,
            source: trigger.source,
            tokens: trigger.tokens,
            triggerAt: trigger.triggerAt,
            shouldCompact: trigger.shouldCompact,
        });
        if (!trigger.shouldCompact) {
            return this.skip(input, trigger.reason ?? 'context_manager_below_threshold');
        }
        const plan = this.selectPlan(activeMessages, trigger.tokens, trigger.triggerAt);
        if (!plan) {
            return this.skip(input, 'context_manager_no_safe_cut_point');
        }
        if (options.beforeCompaction && !(await options.beforeCompaction())) {
            return this.skip(input, 'context_manager_deferred_by_plugin_hook');
        }
        let summary;
        try {
            summary = await this.generateSummary(input, plan);
        }
        catch (err) {
            await this.notify('onCompactionFailed', {
                sessionId: input.sessionId,
                turnId: input.turnId,
                phase: input.phase,
                reason: errorReason('context_manager_summary_failed', err),
            });
            return this.skip(input, 'context_manager_summary_failed');
        }
        if (!summary.trim()) {
            return this.skip(input, 'context_manager_summary_empty');
        }
        const replacementId = this.idGenerator();
        const replacementMessages = [
            createCompactionSummary(summary, plan.tokensBefore, this.nowMs(), plan.keptMessages.length),
            ...plan.keptMessages,
        ];
        const tokensAfter = this.tokenEstimator.estimateContextTokens(replacementMessages).tokens;
        await this.notify('onCompactionCommitted', {
            sessionId: input.sessionId,
            turnId: input.turnId,
            phase: input.phase,
            replacementId,
            tokensBefore: plan.tokensBefore,
            tokensAfter,
            messagesBefore: activeMessages.length,
            messagesAfter: replacementMessages.length,
        });
        return {
            type: 'replaceMessages',
            messages: replacementMessages,
            metadata: {
                replacementId,
                strategyVersion: this.settings.strategyVersion,
                summary,
                compactedMessages: plan.compactedMessages,
                keptMessages: plan.keptMessages,
                firstKeptIndex: plan.firstKeptIndex,
                tokensBefore: plan.tokensBefore,
                tokensAfter,
                messagesBefore: activeMessages.length,
                messagesAfter: replacementMessages.length,
            },
        };
    }
    async evaluateTrigger(messages, input) {
        const contextWindow = input.model.contextWindow > 0
            ? input.model.contextWindow
            : this.settings.contextWindowFallback;
        // Cloud/legacy 保持使用 configured output 的既有触发策略；local-runtime-v2
        // 的动态 Provider 预算由 provider-budget.ts 单独提供。
        const triggerAt = computeCompactionTriggerAt({
            modelId: input.model.id,
            contextWindow,
            perTurnMaxTokens: input.model.maxTokens,
            reserveTokens: this.settings.reserveTokens,
            safetyMarginTokens: this.settings.safetyMarginTokens,
        });
        if (!this.settings.enabled) {
            return {
                shouldCompact: false,
                reason: 'context_manager_disabled',
                tokens: 0,
                source: 'disabled',
                triggerAt,
            };
        }
        if (messages.length <= 1 || messages.length < this.settings.minMessagesToCompact) {
            return {
                shouldCompact: false,
                reason: 'context_manager_not_enough_messages',
                tokens: 0,
                source: 'not_counted',
                triggerAt,
            };
        }
        let count;
        try {
            count = this.tokenCounter
                ? // headers 和 tools 必须原样透传给计数器：headers 里可能带网关鉴权
                    // （缺了远程 count_tokens 直接 401），tools 声明是真实 LLM payload
                    // 的一部分（MCP 重的会话可达数万 token），不带则计数系统性偏低、
                    // 压缩迟迟不触发。
                    await this.tokenCounter.countContextTokens({
                        messages,
                        model: input.model,
                        apiKey: input.apiKey,
                        headers: input.headers,
                        systemPrompt: input.systemPrompt,
                        tools: input.tools,
                        thinkingLevel: input.thinkingLevel,
                        signal: input.signal,
                    })
                : {
                    tokens: this.tokenEstimator.estimateContextTokens(messages).tokens,
                    source: 'local_estimate',
                };
        }
        catch {
            return {
                shouldCompact: false,
                reason: 'context_manager_token_count_failed',
                tokens: 0,
                source: this.tokenCounter ? 'remote_count_tokens' : 'local_estimate',
                triggerAt,
            };
        }
        const shouldCompact = count.tokens > triggerAt;
        return {
            shouldCompact,
            reason: shouldCompact ? undefined : 'context_manager_below_threshold',
            tokens: count.tokens,
            source: count.source,
            triggerAt,
        };
    }
    selectPlan(activeMessages, tokensBefore, triggerAt) {
        const previousSummaryIndex = findLatestCompactionSummaryIndex(activeMessages);
        const boundaryStartIndex = previousSummaryIndex >= 0 ? previousSummaryIndex + 1 : 0;
        const compactableCount = activeMessages.length - boundaryStartIndex;
        if (compactableCount < this.settings.minMessagesToCompact)
            return undefined;
        const effectiveKeepRecentTokens = Math.min(this.settings.keepRecentTokens, Math.max(1, triggerAt));
        const firstKeptIndex = selectFirstKeptIndex(activeMessages, boundaryStartIndex, effectiveKeepRecentTokens, this.tokenEstimator);
        if (firstKeptIndex <= boundaryStartIndex || firstKeptIndex >= activeMessages.length) {
            return undefined;
        }
        const compactedMessages = activeMessages.slice(boundaryStartIndex, firstKeptIndex);
        const keptMessages = activeMessages.slice(firstKeptIndex);
        if (compactedMessages.length < this.settings.minMessagesToCompact ||
            keptMessages.length === 0) {
            return undefined;
        }
        return {
            previousSummary: previousSummaryIndex >= 0
                ? compactionSummaryText(activeMessages[previousSummaryIndex])
                : undefined,
            compactedMessages,
            keptMessages,
            firstKeptIndex,
            boundaryStartIndex,
            tokensBefore,
        };
    }
    async generateSummary(input, plan) {
        if (this.summaryGenerator) {
            return this.summaryGenerator.generateSummary({
                messages: plan.compactedMessages,
                previousSummary: plan.previousSummary,
                model: input.model,
                apiKey: input.apiKey,
                thinkingLevel: input.thinkingLevel,
                reserveTokens: this.settings.reserveTokens,
                signal: input.signal,
            });
        }
        if (!input.apiKey) {
            throw new Error('context_manager_summary_unavailable: missing apiKey for current model');
        }
        const result = await generateSummary(plan.compactedMessages, input.model, this.settings.reserveTokens, input.apiKey, undefined, input.signal, undefined, plan.previousSummary, input.thinkingLevel);
        if (!result.ok) {
            throw new Error(`context_manager_summary_failed: ${result.error.code}: ${result.error.message}`);
        }
        return result.value;
    }
    async skip(input, reason) {
        await this.notify('onCompactionSkipped', {
            sessionId: input.sessionId,
            turnId: input.turnId,
            phase: input.phase,
            reason,
        });
        return { type: 'skip', reason };
    }
    async notify(key, event) {
        const fn = this.observer?.[key];
        if (!fn)
            return;
        try {
            await fn(event);
        }
        catch {
            // Observer errors must never change compaction decisions.
        }
    }
}
class InProcessContextManagerLock {
    sessionLocks = new Map();
    async withSessionLock(sessionId, action) {
        const previous = this.sessionLocks.get(sessionId) ?? Promise.resolve();
        let release = () => undefined;
        const current = new Promise((resolve) => {
            release = resolve;
        });
        const chained = previous.catch(() => undefined).then(() => current);
        this.sessionLocks.set(sessionId, chained);
        await previous.catch(() => undefined);
        try {
            return await action();
        }
        finally {
            release();
            if (this.sessionLocks.get(sessionId) === chained) {
                this.sessionLocks.delete(sessionId);
            }
        }
    }
}
function selectFirstKeptIndex(messages, boundaryStart, keepRecentTokens, tokenEstimator) {
    let candidate = firstValidCutAtOrAfter(messages, boundaryStart, boundaryStart);
    if (candidate < 0)
        return -1;
    let tokens = 0;
    for (let i = messages.length - 1; i >= boundaryStart; i -= 1) {
        tokens += tokenEstimator.estimateMessage(messages[i]);
        if (tokens >= keepRecentTokens) {
            candidate = safeCutForIndex(messages, i, boundaryStart);
            break;
        }
    }
    return candidate;
}
function safeCutForIndex(messages, index, boundaryStart) {
    const message = messages[index];
    if (!message)
        return -1;
    const toolGroupStart = findToolGroupStartForIndex(messages, index, boundaryStart);
    if (toolGroupStart >= boundaryStart)
        return toolGroupStart;
    if (message.role === 'toolResult') {
        return findAssistantForToolResult(messages, index, boundaryStart);
    }
    if (isValidFirstKeptMessage(message))
        return index;
    return firstValidCutAtOrAfter(messages, index, boundaryStart);
}
function firstValidCutAtOrAfter(messages, index, boundaryStart) {
    for (let i = Math.max(index, boundaryStart); i < messages.length; i += 1) {
        const message = messages[i];
        if (!message)
            continue;
        if (message.role === 'toolResult') {
            const assistantIndex = findAssistantForToolResult(messages, i, boundaryStart);
            if (assistantIndex >= boundaryStart)
                return assistantIndex;
            continue;
        }
        if (isValidFirstKeptMessage(message))
            return i;
    }
    return -1;
}
function isValidFirstKeptMessage(message) {
    return message.role !== 'toolResult';
}
function findToolGroupStartForIndex(messages, index, boundaryStart) {
    for (let i = index; i >= boundaryStart; i -= 1) {
        const candidate = messages[i];
        if (!candidate)
            continue;
        if (candidate.role === 'assistant') {
            const toolCallIds = assistantToolCallIds(candidate);
            if (toolCallIds.size === 0)
                return -1;
            const groupEnd = findToolGroupEnd(messages, i, toolCallIds);
            return index <= groupEnd ? i : -1;
        }
        if (isHardToolGroupBoundary(candidate))
            break;
    }
    return -1;
}
function findToolGroupEnd(messages, assistantIndex, toolCallIds) {
    let groupEnd = assistantIndex;
    for (let i = assistantIndex + 1; i < messages.length; i += 1) {
        const message = messages[i];
        if (!message)
            continue;
        if (isHardToolGroupBoundary(message) || message.role === 'assistant')
            break;
        if (message.role === 'toolResult' && toolCallIds.has(message.toolCallId)) {
            groupEnd = i;
        }
    }
    return groupEnd;
}
function assistantToolCallIds(message) {
    const ids = new Set();
    for (const block of message.content) {
        if (block.type === 'toolCall')
            ids.add(block.id);
    }
    return ids;
}
function isHardToolGroupBoundary(message) {
    return (message.role === 'user' ||
        message.role === 'branchSummary' ||
        message.role === 'compactionSummary');
}
function findAssistantForToolResult(messages, toolResultIndex, boundaryStart) {
    const result = messages[toolResultIndex];
    const toolCallId = result.toolCallId;
    for (let i = toolResultIndex - 1; i >= boundaryStart; i -= 1) {
        const candidate = messages[i];
        if (!candidate)
            continue;
        if (candidate.role === 'assistant' && assistantHasToolCall(candidate, toolCallId))
            return i;
        if (isHardToolGroupBoundary(candidate))
            break;
    }
    return -1;
}
function assistantHasToolCall(message, toolCallId) {
    return message.content.some((block) => block.type === 'toolCall' && block.id === toolCallId);
}
function findLatestCompactionSummaryIndex(messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (compactionSummaryText(messages[i]) !== undefined)
            return i;
    }
    return -1;
}
function compactionSummaryText(message) {
    if (!message || message.role !== 'compactionSummary')
        return undefined;
    return message.summary;
}
function createCompactionSummary(summary, tokensBefore, timestamp, keptMessageCount) {
    return {
        role: 'compactionSummary',
        summary,
        tokensBefore,
        timestamp,
        keptMessageCount,
    };
}
function errorReason(prefix, err) {
    const message = err instanceof Error ? err.message : String(err);
    return message.startsWith(`${prefix}:`) ? message : `${prefix}: ${message}`;
}
function defaultReplacementId() {
    return `ctx-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}
//# sourceMappingURL=manager.js.map