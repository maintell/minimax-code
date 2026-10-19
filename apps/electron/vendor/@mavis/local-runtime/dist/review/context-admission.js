import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { estimateReviewInputTokensLocally, measureReviewInputTokens, } from './context-token-measurer.js';
const TECHNICAL_REPLACEMENT_STRATEGY = 'review-context-git-discovery-v1';
const SCREENSHOT_TOOLS = new Set(['computer_app_state']);
export class ReviewContextAdmission {
    options;
    affectedProfileDailyGate;
    constructor(options) {
        this.options = options;
        this.affectedProfileDailyGate =
            options.affectedProfileDailyGate ??
                new ReviewAffectedProfileDailyGate(() => options.configGetter().dataDir);
    }
    async evaluate(input, state, identity) {
        const prepared = state.prepared;
        if (!prepared || prepared.mode !== 'inline' || state.delivery !== 'full')
            return undefined;
        const budget = resolveInputBudget(input);
        if (!budget) {
            this.recordAdmission('invalid_budget', {
                input,
                identity,
                contextWindow: 0,
                maxOutputTokens: 0,
                inputBudgetTokens: 0,
                hasCuScreenshot: containsCuScreenshot(input.messages),
            });
            return undefined;
        }
        const context = {
            input,
            identity,
            ...budget,
            hasCuScreenshot: containsCuScreenshot(input.messages),
        };
        let measurement;
        try {
            measurement = await (this.options.measureInputTokens ?? measureReviewInputTokens)(input, budget.inputBudgetTokens, this.options.remoteCounter);
            if (!Number.isSafeInteger(measurement.tokens) || measurement.tokens < 0) {
                throw new Error('Review input token measurement is invalid');
            }
        }
        catch {
            this.recordAdmission('measurement_failed', context);
            this.safeLog('warn', {
                event: 'code_review_context_measurement_failed',
                sessionId: identity.sessionId,
                turnId: identity.turnId,
                phase: input.phase,
                model: input.model.id,
                api: input.model.api,
                contextWindow: budget.contextWindow,
                maxOutputTokens: budget.maxOutputTokens,
                inputBudgetTokens: budget.inputBudgetTokens,
            }, 'Code review context token measurement failed');
            return undefined;
        }
        this.recordTokenDistribution(context, measurement);
        if (measurement.tokens <= budget.inputBudgetTokens) {
            this.recordAdmission('fit', context, measurement);
            return undefined;
        }
        const fullReminder = state.renderedFullReminder;
        const compactReminder = state.renderedCompactReminder;
        if (!fullReminder || !compactReminder) {
            this.recordAdmission('replacement_not_found', context, measurement);
            return undefined;
        }
        const replacement = replaceLatestExactReviewReminder(input.messages, fullReminder, compactReminder);
        if (!replacement) {
            this.recordAdmission('replacement_not_found', context, measurement);
            this.safeLog('warn', {
                event: 'code_review_context_reminder_not_found',
                sessionId: identity.sessionId,
                turnId: identity.turnId,
                phase: input.phase,
                model: input.model.id,
                api: input.model.api,
                messageCount: input.messages.length,
            }, 'Code review full reminder was not found for compact replacement');
            return undefined;
        }
        const after = this.estimateReplacement(input, replacement.messages);
        const tokensRemoved = after
            ? Math.max(0, measurement.localTokens - after.localTokens)
            : undefined;
        const tokensAfter = tokensRemoved === undefined ? undefined : Math.max(0, measurement.tokens - tokensRemoved);
        state.useGitDiscovery();
        this.recordAdmission('overflow_compacted', context, measurement);
        try {
            await this.recordOmission(context, state, measurement, tokensAfter, tokensRemoved);
        }
        catch {
            this.safeLog('warn', {
                event: 'code_review_context_telemetry_failed',
                sessionId: identity.sessionId,
                turnId: identity.turnId,
            }, 'Code review context omission telemetry failed');
        }
        return {
            type: 'replaceMessages',
            messages: replacement.messages,
            metadata: {
                replacementId: (this.options.makeId ?? randomUUID)(),
                strategyVersion: TECHNICAL_REPLACEMENT_STRATEGY,
                summary: 'Omitted the oversized precomputed code review change manifest.',
                compactedMessages: [],
                keptMessages: replacement.messages,
                firstKeptIndex: 0,
                replacementSourceIndexes: replacement.messages.map((_, index) => index),
                tokensBefore: measurement.tokens,
                ...(tokensAfter !== undefined ? { tokensAfter } : {}),
                messagesBefore: input.messages.length,
                messagesAfter: replacement.messages.length,
            },
        };
    }
    estimateReplacement(input, messages) {
        try {
            return estimateReviewInputTokensLocally({ ...input, messages });
        }
        catch {
            return undefined;
        }
    }
    recordTokenDistribution(context, measurement) {
        const labels = metricLabels(context, measurement.source);
        this.safeHistogram('review_context_input_tokens', measurement.tokens, labels);
        this.safeHistogram('review_context_input_budget_tokens', Math.max(0, context.inputBudgetTokens), labels);
        if (measurement.tokens > context.inputBudgetTokens) {
            this.safeHistogram('review_context_overflow_excess_tokens', measurement.tokens - context.inputBudgetTokens, labels);
        }
    }
    recordAdmission(outcome, context, measurement) {
        this.safeCounter('review_context_admission_total', {
            ...metricLabels(context, measurement?.source ?? 'unavailable'),
            outcome,
        });
    }
    async recordOmission(context, state, measurement, tokensAfter, tokensRemoved) {
        const prepared = state.prepared;
        if (!prepared)
            return;
        const labels = metricLabels(context, measurement.source);
        this.safeCounter('review_context_manifest_omission_total', labels);
        if (tokensRemoved !== undefined) {
            this.safeHistogram('review_context_tokens_removed', tokensRemoved, labels);
        }
        const nowMs = (this.options.nowMs ?? Date.now)();
        await this.recordAffectedProfile(utcDate(nowMs), labels);
        this.safeLog('info', {
            event: 'code_review_context_manifest_omitted',
            reviewRunId: prepared.context.reviewRunId,
            sessionId: context.identity.sessionId,
            turnId: context.identity.turnId,
            phase: context.input.phase,
            model: context.input.model.id,
            api: context.input.model.api,
            inputTokens: measurement.tokens,
            ...(tokensAfter !== undefined ? { tokensAfterReviewReplacement: tokensAfter } : {}),
            inputBudgetTokens: context.inputBudgetTokens,
            contextWindow: context.contextWindow,
            maxOutputTokens: context.maxOutputTokens,
            overflowTokens: measurement.tokens - context.inputBudgetTokens,
            measurementSource: measurement.source,
            messageCount: measurement.messageCount,
            toolCount: context.input.tools?.length ?? 0,
            hasCuScreenshot: context.hasCuScreenshot,
            changedFileCount: prepared.context.changedFiles?.size ?? 0,
            changedRangeCount: countChangedRanges(prepared.context.changedFiles),
        }, 'Code review change manifest omitted from oversized model input');
    }
    async recordAffectedProfile(date, labels) {
        if (!this.options.metricsClient)
            return;
        try {
            if (await this.affectedProfileDailyGate.claim(date)) {
                this.safeCounter('review_context_overflow_affected_profile_daily_total', labels);
            }
        }
        catch {
            this.safeLog('warn', {
                event: 'code_review_affected_profile_daily_claim_failed',
                utcDate: date,
            }, 'Code review affected profile daily metric claim failed');
        }
    }
    safeCounter(name, labels) {
        try {
            this.options.metricsClient?.counter(name, 1, labels);
        }
        catch {
            // Telemetry cannot affect Review admission.
        }
    }
    safeHistogram(name, value, labels) {
        try {
            this.options.metricsClient?.histogram(name, value, labels);
        }
        catch {
            // Telemetry cannot affect Review admission.
        }
    }
    safeLog(level, fields, message) {
        try {
            this.options.logger?.[level](fields, message);
        }
        catch {
            // Logging cannot affect Review admission.
        }
    }
}
export class ReviewAffectedProfileDailyGate {
    dataDirGetter;
    constructor(dataDirGetter) {
        this.dataDirGetter = dataDirGetter;
    }
    async claim(utcDay) {
        if (!/^\d{4}-\d{2}-\d{2}$/u.test(utcDay)) {
            throw new Error('Invalid UTC day for Review affected-profile metric');
        }
        const directory = join(this.dataDirGetter(), 'v2', 'review', 'telemetry', 'affected-profile-days');
        await mkdir(directory, { recursive: true });
        try {
            await writeFile(join(directory, `${utcDay}.marker`), '1\n', { flag: 'wx' });
            return true;
        }
        catch (error) {
            if (isNodeError(error) && error.code === 'EEXIST')
                return false;
            throw error;
        }
    }
}
export function replaceLatestExactReviewReminder(messages, fullReminder, compactReminder) {
    if (!fullReminder || fullReminder === compactReminder)
        return undefined;
    for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
        const message = messages[messageIndex];
        if (!isRecord(message) || !isReplaceableRole(message.role))
            continue;
        if (typeof message.content === 'string') {
            const replaced = replaceLast(message.content, fullReminder, compactReminder);
            if (replaced === undefined)
                continue;
            const output = [...messages];
            output[messageIndex] = { ...message, content: replaced };
            return { messages: output };
        }
        if (!Array.isArray(message.content))
            continue;
        for (let contentIndex = message.content.length - 1; contentIndex >= 0; contentIndex -= 1) {
            const block = message.content[contentIndex];
            if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string')
                continue;
            const replaced = replaceLast(block.text, fullReminder, compactReminder);
            if (replaced === undefined)
                continue;
            const content = [...message.content];
            content[contentIndex] = { ...block, text: replaced };
            const output = [...messages];
            output[messageIndex] = { ...message, content };
            return { messages: output };
        }
    }
    return undefined;
}
function resolveInputBudget(input) {
    const contextWindow = positiveSafeInteger(input.model?.contextWindow);
    const maxOutputTokens = positiveSafeInteger(input.maxTokens) ?? positiveSafeInteger(input.model?.maxTokens);
    if (contextWindow === undefined || maxOutputTokens === undefined)
        return undefined;
    return {
        contextWindow,
        maxOutputTokens,
        inputBudgetTokens: contextWindow - maxOutputTokens,
    };
}
function metricLabels(context, measurementSource) {
    return {
        mode: 'inline',
        phase: context.input.phase ?? 'unknown',
        measurementSource,
        api: context.input.model?.api ?? 'unknown',
        hasCuScreenshot: String(context.hasCuScreenshot),
    };
}
function containsCuScreenshot(messages) {
    return (messages ?? []).some((message) => {
        if (!isRecord(message))
            return false;
        const record = message;
        const role = record.role;
        if (role !== 'tool' && role !== 'toolResult') {
            return false;
        }
        const name = record.toolName ?? record.tool_name ?? record.name;
        if (typeof name !== 'string' || !SCREENSHOT_TOOLS.has(name))
            return false;
        return (Array.isArray(record.content) &&
            record.content.some((block) => isRecord(block) && block.type === 'image'));
    });
}
function countChangedRanges(changedFiles) {
    if (!changedFiles)
        return 0;
    let count = 0;
    for (const file of changedFiles.values())
        count += file.ranges.length;
    return count;
}
function replaceLast(value, target, replacement) {
    const index = value.lastIndexOf(target);
    if (index < 0)
        return undefined;
    return value.slice(0, index) + replacement + value.slice(index + target.length);
}
function positiveSafeInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function utcDate(timestampMs) {
    return new Date(timestampMs).toISOString().slice(0, 10);
}
function isReplaceableRole(value) {
    return value === 'user' || value === 'tool' || value === 'toolResult';
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isNodeError(error) {
    return error instanceof Error;
}
//# sourceMappingURL=context-admission.js.map