import { GoogleGenAI, ResourceScope, } from "@google/genai";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { notifyProviderError } from "../utils/provider-error.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { consumeGoogleStream, convertMessages, convertTools, getDisabledGoogleThinkingConfig, getGeminiMajorVersion, mapToolChoice, resolveGoogleThinkingRequest, toGoogleSdkThinkingLevel, } from "./google-shared.js";
import { buildBaseOptions } from "./simple-options.js";
const API_VERSION = "v1";
const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";
export const streamGoogleVertex = (model, context, options) => {
    const stream = new AssistantMessageEventStream();
    (async () => {
        const output = {
            role: "assistant",
            content: [],
            api: "google-vertex",
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
            const apiKey = resolveApiKey(options);
            // Create the client using either a Vertex API key, if provided, or ADC with project and location
            const client = apiKey
                ? createClientWithApiKey(model, apiKey, options?.headers, options?.fetch)
                : createClient(model, resolveProject(options), resolveLocation(options), options?.headers, options?.fetch);
            let params = buildParams(model, context, options);
            const nextParams = await options?.onPayload?.(params, model);
            if (nextParams !== undefined) {
                params = nextParams;
            }
            if (getGeminiMajorVersion(params.model || model.id) === 4 &&
                (params.config?.maxOutputTokens ?? 0) > 65_536 &&
                resolveBaseUrlApiVersion(model.baseUrl) === "v1") {
                throw new Error("Gemini 4 output above 65,536 tokens requires a v1beta1 Vertex endpoint; update the base URL from v1 to v1beta1");
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
export const streamSimpleGoogleVertex = (model, context, options) => {
    return streamGoogleVertex(model, context, {
        ...buildBaseOptions(model, options, undefined),
        thinking: resolveGoogleThinkingRequest(model, options?.reasoning, options?.thinkingBudgets),
    });
};
function createClient(model, project, location, optionsHeaders, fetch) {
    return new GoogleGenAI({
        vertexai: true,
        project,
        location,
        apiVersion: getGeminiMajorVersion(model.id) === 4 ? "v1beta1" : API_VERSION,
        httpOptions: buildHttpOptions(model, optionsHeaders, fetch),
    });
}
function createClientWithApiKey(model, apiKey, optionsHeaders, fetch) {
    return new GoogleGenAI({
        vertexai: true,
        apiKey,
        apiVersion: getGeminiMajorVersion(model.id) === 4 ? "v1beta1" : API_VERSION,
        httpOptions: buildHttpOptions(model, optionsHeaders, fetch),
    });
}
function buildHttpOptions(model, optionsHeaders, fetch) {
    const httpOptions = {};
    const baseUrl = resolveCustomBaseUrl(model.baseUrl);
    if (baseUrl) {
        httpOptions.baseUrl = baseUrl;
        httpOptions.baseUrlResourceScope = ResourceScope.COLLECTION;
        if (resolveBaseUrlApiVersion(baseUrl) !== undefined) {
            httpOptions.apiVersion = "";
        }
    }
    if (model.headers || optionsHeaders) {
        httpOptions.headers = { ...model.headers, ...optionsHeaders };
    }
    // Send through the host transport (proxy, CA, capture) like the other providers.
    if (fetch)
        httpOptions.fetch = fetch;
    return Object.keys(httpOptions).length > 0 ? httpOptions : undefined;
}
function resolveCustomBaseUrl(baseUrl) {
    const trimmed = baseUrl.trim();
    if (!trimmed || trimmed.includes("{location}")) {
        return undefined;
    }
    return trimmed;
}
function resolveBaseUrlApiVersion(baseUrl) {
    const resolved = resolveCustomBaseUrl(baseUrl);
    if (!resolved)
        return undefined;
    let pathname = resolved;
    try {
        pathname = new URL(resolved).pathname;
    }
    catch {
        pathname = resolved.split(/[?#]/, 1)[0] ?? resolved;
    }
    let version;
    const parts = pathname.split("/");
    for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index] ?? "";
        const prev = index > 0 ? (parts[index - 1] ?? "").toLowerCase() : "";
        if (prev === "projects" || prev === "locations" || prev === "publishers" || prev === "models") {
            continue;
        }
        if (/^v\d+(?:beta\d*)?$/i.test(part)) {
            version = part.toLowerCase();
        }
    }
    return version;
}
function resolveApiKey(options) {
    const apiKey = options?.apiKey?.trim();
    if (!apiKey || apiKey === GCP_VERTEX_CREDENTIALS_MARKER || isPlaceholderApiKey(apiKey)) {
        return undefined;
    }
    return apiKey;
}
function isPlaceholderApiKey(apiKey) {
    return /^<[^>]+>$/.test(apiKey);
}
function resolveProject(options) {
    const project = options?.project || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
    if (!project) {
        throw new Error("Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT or pass project in options.");
    }
    return project;
}
function resolveLocation(options) {
    const location = options?.location || process.env.GOOGLE_CLOUD_LOCATION;
    if (!location) {
        throw new Error("Vertex AI requires a location. Set GOOGLE_CLOUD_LOCATION or pass location in options.");
    }
    return location;
}
function buildParams(model, context, options = {}) {
    const contents = convertMessages(model, context);
    const longOutputModel = getGeminiMajorVersion(model.id) === 4;
    const generationConfig = { automaticContinuation: longOutputModel };
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
    if (options.thinking?.enabled && model.reasoning) {
        const thinkingConfig = { includeThoughts: true };
        if (options.thinking.level !== undefined) {
            thinkingConfig.thinkingLevel = toGoogleSdkThinkingLevel(options.thinking.level);
        }
        else if (options.thinking.budgetTokens !== undefined) {
            thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
        }
        config.thinkingConfig = thinkingConfig;
    }
    else if (model.reasoning && options.thinking && !options.thinking.enabled) {
        config.thinkingConfig = getDisabledGoogleThinkingConfig(model);
    }
    if (options.signal) {
        if (options.signal.aborted) {
            throw new Error("Request aborted");
        }
        config.abortSignal = options.signal;
    }
    const params = {
        model: model.id,
        contents,
        config,
    };
    return params;
}
//# sourceMappingURL=google-vertex.js.map