import { convertMessages, convertTools, toProviderMessages, } from './messages-count-tokens-messages.js';
import { isMessagesOAuthToken, sanitizeSurrogates, } from './messages-count-tokens-wire.js';
export function buildMessagesCountTokensRequestBody(input) {
    const { messages, systemPrompt, model, tools, options = {} } = input;
    const context = {
        systemPrompt,
        messages: toProviderMessages(messages, model),
        tools,
    };
    const params = buildMessagesParams({
        model: model,
        context,
        isOAuthToken: isMessagesOAuthToken(options.apiKey ?? ''),
        options: buildMessagesOptionsFromSimple(model, options),
    });
    return {
        model: params.model,
        messages: params.messages,
        stream: false,
        ...(params.system ? { system: params.system } : {}),
        ...(params.tools
            ? {
                tools: params.tools.map(({ eager_input_streaming: _eagerInputStreaming, ...tool }) => tool),
            }
            : {}),
        ...(params.thinking !== undefined ? { thinking: params.thinking } : {}),
    };
}
/**
 * Convert the exact generation payload captured by `onPayload` into the
 * strict count_tokens schema while preserving its input-bearing fields.
 */
export function buildMessagesCountTokensRequestBodyFromProviderPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        return undefined;
    const record = payload;
    if (typeof record.model !== 'string' || !Array.isArray(record.messages))
        return undefined;
    return {
        model: record.model,
        messages: record.messages,
        stream: false,
        ...(Array.isArray(record.system) ? { system: record.system } : {}),
        ...(Array.isArray(record.tools)
            ? {
                tools: record.tools.map(({ eager_input_streaming: _eagerInputStreaming, ...tool }) => tool),
            }
            : {}),
        ...(record.thinking === undefined ? {} : { thinking: record.thinking }),
        ...(record.tool_choice === undefined ? {} : { tool_choice: record.tool_choice }),
    };
}
function buildMessagesOptionsFromSimple(model, options) {
    const base = {
        maxTokens: options.maxTokens,
        cacheRetention: options.cacheRetention,
    };
    const reasoning = options.thinkingLevel && options.thinkingLevel !== 'off' ? options.thinkingLevel : undefined;
    if (!reasoning)
        return { ...base, thinkingEnabled: false };
    if (model.compat?.forceAdaptiveThinking === true) {
        return {
            ...base,
            thinkingEnabled: true,
            effort: mapThinkingLevelToEffort(model, reasoning),
        };
    }
    const adjusted = adjustMaxTokensForThinking(base.maxTokens, model.maxTokens, reasoning);
    return {
        ...base,
        maxTokens: adjusted.maxTokens,
        thinkingEnabled: true,
        thinkingBudgetTokens: adjusted.thinkingBudget,
    };
}
function buildMessagesParams(input) {
    const { model, context, isOAuthToken, options } = input;
    const { cacheControl } = getCacheControl(model, options.cacheRetention);
    const compat = getMessagesCompat(model);
    const params = {
        model: model.id,
        messages: convertMessages({
            messages: context.messages,
            model,
            isOAuthToken,
            cacheControl,
            allowEmptySignature: compat.allowEmptySignature,
        }),
        max_tokens: options.maxTokens ?? model.maxTokens,
        stream: true,
    };
    const system = buildMessagesSystem(context.systemPrompt, isOAuthToken, cacheControl);
    if (system)
        params.system = system;
    if (context.tools && context.tools.length > 0) {
        params.tools = convertTools(context.tools, isOAuthToken, compat.supportsEagerToolInputStreaming, compat.supportsCacheControlOnTools ? cacheControl : undefined);
    }
    const thinking = buildMessagesThinking(model, options);
    if (thinking) {
        params.thinking = thinking.thinking;
        if (thinking.outputConfig)
            params.output_config = thinking.outputConfig;
    }
    return params;
}
function buildMessagesSystem(systemPrompt, isOAuthToken, cacheControl) {
    if (isOAuthToken) {
        return [
            { type: 'text', text: 'hi', ...(cacheControl ? { cache_control: cacheControl } : {}) },
            ...(systemPrompt
                ? [
                    {
                        type: 'text',
                        text: sanitizeSurrogates(systemPrompt),
                        ...(cacheControl ? { cache_control: cacheControl } : {}),
                    },
                ]
                : []),
        ];
    }
    return systemPrompt
        ? [
            {
                type: 'text',
                text: sanitizeSurrogates(systemPrompt),
                ...(cacheControl ? { cache_control: cacheControl } : {}),
            },
        ]
        : undefined;
}
function buildMessagesThinking(model, options) {
    if (!model.reasoning || options.thinkingEnabled === undefined)
        return undefined;
    if (options.thinkingEnabled === false)
        return { thinking: { type: 'disabled' } };
    const display = options.thinkingDisplay ?? 'summarized';
    if (model.compat?.forceAdaptiveThinking === true) {
        return {
            thinking: { type: 'adaptive', display },
            ...(options.effort ? { outputConfig: { effort: options.effort } } : {}),
        };
    }
    return {
        thinking: {
            type: 'enabled',
            budget_tokens: options.thinkingBudgetTokens || 1024,
            display,
        },
    };
}
function getCacheControl(model, cacheRetention) {
    const retention = cacheRetention ?? (process.env.PI_CACHE_RETENTION === 'long' ? 'long' : 'short');
    if (retention === 'none')
        return { retention };
    const ttl = retention === 'long' && getMessagesCompat(model).supportsLongCacheRetention ? '1h' : undefined;
    return {
        retention,
        cacheControl: { type: 'ephemeral', ...(ttl ? { ttl } : {}) },
    };
}
function getMessagesCompat(model) {
    const isFireworks = model.provider === 'fireworks';
    const isCloudflareAiGatewayMessages = model.provider === 'cloudflare-ai-gateway' && model.baseUrl.includes('anthropic');
    return {
        supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? !isFireworks,
        supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? !isFireworks,
        sendSessionAffinityHeaders: model.compat?.sendSessionAffinityHeaders ?? !!(isFireworks || isCloudflareAiGatewayMessages),
        supportsCacheControlOnTools: model.compat?.supportsCacheControlOnTools ?? !isFireworks,
        supportsTemperature: model.compat?.supportsTemperature ?? true,
        allowEmptySignature: model.compat?.allowEmptySignature ?? false,
    };
}
function adjustMaxTokensForThinking(baseMaxTokens, modelMaxTokens, reasoningLevel) {
    const budgets = {
        minimal: 1024,
        low: 2048,
        medium: 8192,
        high: 16384,
    };
    const minOutputTokens = 1024;
    const level = reasoningLevel === 'xhigh' || reasoningLevel === 'max' ? 'high' : reasoningLevel;
    let thinkingBudget = budgets[level];
    const maxTokens = baseMaxTokens === undefined
        ? modelMaxTokens
        : Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);
    if (maxTokens <= thinkingBudget)
        thinkingBudget = Math.max(0, maxTokens - minOutputTokens);
    return { maxTokens, thinkingBudget };
}
function mapThinkingLevelToEffort(model, level) {
    const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
    if (typeof mapped === 'string')
        return mapped;
    switch (level) {
        case 'minimal':
        case 'low':
            return 'low';
        case 'medium':
            return 'medium';
        default:
            return 'high';
    }
}
//# sourceMappingURL=messages-count-tokens-payload.js.map