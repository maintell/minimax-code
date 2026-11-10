import { GoogleGenAI, } from "@google/genai";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { notifyProviderError } from "../utils/provider-error.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { consumeGoogleStream, convertMessages, convertTools, getDisabledGoogleThinkingConfig, mapToolChoice, resolveGoogleThinkingRequest, toGoogleSdkThinkingLevel, } from "./google-shared.js";
import { buildBaseOptions } from "./simple-options.js";
export const streamGoogle = (model, context, options) => {
    const stream = new AssistantMessageEventStream();
    (async () => {
        const output = {
            role: "assistant",
            content: [],
            api: "google-generative-ai",
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
            stopReason: "stop",
            timestamp: Date.now(),
        };
        try {
            const apiKey = options?.apiKey;
            if (!apiKey) {
                throw new Error(`No API key for provider: ${model.provider}`);
            }
            const client = createClient(model, apiKey, options?.headers);
            let params = buildParams(model, context, options);
            const nextParams = await options?.onPayload?.(params, model);
            if (nextParams !== undefined) {
                params = nextParams;
            }
            const googleStream = await client.models.generateContentStream(params);
            await consumeGoogleStream(googleStream, output, stream, model, options);
        }
        catch (error) {
            notifyProviderError(options?.onProviderError, error, model);
            output.stopReason = options?.signal?.aborted ? "aborted" : "error";
            output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
            stream.push({ type: "error", reason: output.stopReason, error: output });
            stream.end();
        }
    })();
    return stream;
};
export const streamSimpleGoogle = (model, context, options) => {
    const apiKey = options?.apiKey;
    if (!apiKey) {
        throw new Error(`No API key for provider: ${model.provider}`);
    }
    return streamGoogle(model, context, {
        ...buildBaseOptions(model, options, apiKey),
        thinking: resolveGoogleThinkingRequest(model, options?.reasoning, options?.thinkingBudgets),
    });
};
function createClient(model, apiKey, optionsHeaders) {
    const httpOptions = {};
    if (model.baseUrl) {
        httpOptions.baseUrl = model.baseUrl;
        httpOptions.apiVersion = ""; // baseUrl already includes version path, don't append
    }
    if (model.headers || optionsHeaders) {
        httpOptions.headers = { ...model.headers, ...optionsHeaders };
    }
    return new GoogleGenAI({
        apiKey,
        httpOptions: Object.keys(httpOptions).length > 0 ? httpOptions : undefined,
    });
}
function buildParams(model, context, options = {}) {
    const contents = convertMessages(model, context);
    const generationConfig = {};
    if (options.temperature !== undefined) {
        generationConfig.temperature = options.temperature;
    }
    if (options.maxTokens !== undefined) {
        generationConfig.maxOutputTokens = options.maxTokens;
    }
    const config = {
        ...(Object.keys(generationConfig).length > 0 && generationConfig),
        ...(context.systemPrompt && { systemInstruction: sanitizeSurrogates(context.systemPrompt) }),
        ...(context.tools && context.tools.length > 0 && { tools: convertTools(context.tools) }),
    };
    if (context.tools && context.tools.length > 0 && options.toolChoice) {
        config.toolConfig = {
            functionCallingConfig: {
                mode: mapToolChoice(options.toolChoice),
            },
        };
    }
    else {
        config.toolConfig = undefined;
    }
    const thinkingConfig = buildThinkingConfig(model, options.thinking);
    if (thinkingConfig)
        config.thinkingConfig = thinkingConfig;
    if (options.signal) {
        if (options.signal.aborted) {
            throw new Error("Request aborted");
        }
        config.abortSignal = options.signal;
    }
    return {
        model: model.id,
        contents,
        config,
    };
}
/**
 * The `thinkingConfig` that `streamSimpleGoogle` sends for a pi reasoning level
 * (`undefined` reasoning means thinking off). Hosts use it to build REST probes
 * that match real turns.
 */
export function getSimpleGoogleThinkingConfig(model, reasoning, thinkingBudgets) {
    return buildThinkingConfig(model, resolveGoogleThinkingRequest(model, reasoning, thinkingBudgets));
}
function buildThinkingConfig(model, thinking) {
    if (!model.reasoning || !thinking)
        return undefined;
    if (!thinking.enabled)
        return getDisabledGoogleThinkingConfig(model);
    const thinkingConfig = { includeThoughts: true };
    if (thinking.level !== undefined) {
        thinkingConfig.thinkingLevel = toGoogleSdkThinkingLevel(thinking.level);
    }
    else if (thinking.budgetTokens !== undefined) {
        thinkingConfig.thinkingBudget = thinking.budgetTokens;
    }
    return thinkingConfig;
}
//# sourceMappingURL=google.js.map