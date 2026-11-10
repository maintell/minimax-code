/**
 * Shared utilities for Google Generative AI and Google Vertex providers.
 */
import { FinishReason, FunctionCallingConfigMode, ThinkingLevel as GoogleSdkThinkingLevel, } from "@google/genai";
import { calculateCost, clampThinkingLevel } from "../models.js";
import { withProviderEventObserver } from "../utils/provider-error.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { transformMessages } from "./transform-messages.js";
const GOOGLE_SDK_THINKING_LEVEL_MAP = {
    THINKING_LEVEL_UNSPECIFIED: GoogleSdkThinkingLevel.THINKING_LEVEL_UNSPECIFIED,
    MINIMAL: GoogleSdkThinkingLevel.MINIMAL,
    LOW: GoogleSdkThinkingLevel.LOW,
    MEDIUM: GoogleSdkThinkingLevel.MEDIUM,
    HIGH: GoogleSdkThinkingLevel.HIGH,
};
/** Resolve a supported pi level or model-specific Google mapping to a standard Google level. */
export function resolveGoogleThinkingLevel(model, level) {
    const mapped = model.thinkingLevelMap?.[level];
    const resolvedLevel = typeof mapped === "string" ? mapped.toLowerCase() : level;
    switch (resolvedLevel) {
        case "minimal":
        case "low":
        case "medium":
        case "high":
            return resolvedLevel;
        default:
            throw new Error(`Unsupported Google thinking level mapping for ${model.provider}/${model.id}: ${level} -> ${String(mapped)}`);
    }
}
/**
 * Whether this model uses Gemini's discrete `thinkingLevel` control instead of
 * the token-based `thinkingBudget` control. Supported levels come from the
 * model's `thinkingLevelMap`; this only selects the Google wire format.
 */
export function usesGoogleThinkingLevel(model) {
    const id = model.id.toLowerCase();
    return (
    // Gemini 3 Pro/Flash with or without a minor version, such as
    // gemini-3-flash-preview, gemini-3.1-pro-preview and gemini-3.8-flash.
    /gemini-3(?:\.\d+)?-(?:pro|flash)/.test(id) ||
        // Gemini 4 and later, such as gemini-4-argon.
        /gemini-(?:[4-9]|[1-9]\d)/.test(id) ||
        // Both hosted Gemma 4 naming forms: gemma-4-* and gemma4-*.
        /gemma-?4/.test(id));
}
export function toGoogleThinkingLevel(level) {
    switch (level) {
        case "minimal":
            return "MINIMAL";
        case "low":
            return "LOW";
        case "medium":
            return "MEDIUM";
        case "high":
            return "HIGH";
    }
}
export function toGoogleSdkThinkingLevel(level) {
    return GOOGLE_SDK_THINKING_LEVEL_MAP[level];
}
/**
 * Thinking config used when pi asks for no reasoning.
 *
 * Gemini 3+ cannot turn thinking off. Send the lowest level the model's
 * `thinkingLevelMap` allows (without `includeThoughts`, so the hidden thinking
 * stays invisible to pi). Gemini 3.8 Flash and Gemini 4 reject `MINIMAL`, so
 * a model without a level map falls back to `LOW`, which every Gemini 3+
 * model accepts; `thinkingBudget: 0` does not disable thinking there.
 */
export function getDisabledGoogleThinkingConfig(model) {
    if (!usesGoogleThinkingLevel(model))
        return { thinkingBudget: 0 };
    const fallback = clampThinkingLevel(model, "off");
    if (fallback === "off") {
        return /^gemini-/i.test(model.id) ? { thinkingLevel: GoogleSdkThinkingLevel.LOW } : { thinkingBudget: 0 };
    }
    const apiLevel = toGoogleThinkingLevel(resolveGoogleThinkingLevel(model, fallback));
    return { thinkingLevel: toGoogleSdkThinkingLevel(apiLevel) };
}
/** Token budget for budget-based (Gemini 2.x) thinking. -1 lets the model decide. */
export function getGoogleThinkingBudget(model, level, customBudgets) {
    const customBudget = customBudgets?.[level];
    if (customBudget !== undefined)
        return customBudget;
    if (model.id.includes("2.5-pro")) {
        const budgets = {
            minimal: 128,
            low: 2048,
            medium: 8192,
            high: 32768,
        };
        return budgets[level];
    }
    if (model.id.includes("2.5-flash-lite")) {
        const budgets = {
            minimal: 512,
            low: 2048,
            medium: 8192,
            high: 24576,
        };
        return budgets[level];
    }
    if (model.id.includes("2.5-flash")) {
        const budgets = {
            minimal: 128,
            low: 2048,
            medium: 8192,
            high: 24576,
        };
        return budgets[level];
    }
    return -1;
}
/** Map a pi reasoning request onto the Google wire format for this model. */
export function resolveGoogleThinkingRequest(model, reasoning, thinkingBudgets) {
    if (!reasoning)
        return { enabled: false };
    const clamped = clampThinkingLevel(model, reasoning);
    if (clamped === "off")
        return { enabled: false };
    const resolved = resolveGoogleThinkingLevel(model, clamped);
    if (usesGoogleThinkingLevel(model)) {
        return { enabled: true, level: toGoogleThinkingLevel(resolved) };
    }
    return { enabled: true, budgetTokens: getGoogleThinkingBudget(model, resolved, thinkingBudgets) };
}
/**
 * Determines whether a streamed Gemini `Part` should be treated as "thinking".
 *
 * Protocol note (Gemini / Vertex AI thought signatures):
 * - `thought: true` is the definitive marker for thinking content (thought summaries).
 * - `thoughtSignature` is an encrypted representation of the model's internal thought process
 *   used to preserve reasoning context across multi-turn interactions.
 * - `thoughtSignature` can appear on ANY part type (text, functionCall, etc.) - it does NOT
 *   indicate the part itself is thinking content.
 * - For non-functionCall responses, the signature appears on the last part for context replay.
 * - When persisting/replaying model outputs, signature-bearing parts must be preserved as-is;
 *   do not merge/move signatures across parts.
 *
 * See: https://ai.google.dev/gemini-api/docs/thought-signatures
 */
export function isThinkingPart(part) {
    return part.thought === true;
}
/**
 * Retain thought signatures during streaming.
 *
 * Some backends only send `thoughtSignature` on the first delta for a given part/block; later deltas may omit it.
 * This helper preserves the last non-empty signature for the current block.
 *
 * Note: this does NOT merge or move signatures across distinct response parts. It only prevents
 * a signature from being overwritten with `undefined` within the same streamed block.
 */
export function retainThoughtSignature(existing, incoming) {
    if (typeof incoming === "string" && incoming.length > 0)
        return incoming;
    return existing;
}
// Thought signatures must be base64 for Google APIs (TYPE_BYTES).
const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;
/**
 * Documented Gemini API placeholder for function calls the API did not sign
 * (for example history produced by another model). Only the Gemini Developer
 * API accepts it; Vertex parses `thoughtSignature` as bytes and rejects it.
 * See: https://ai.google.dev/gemini-api/docs/thought-signatures
 */
const SKIP_THOUGHT_SIGNATURE_VALIDATOR = "skip_thought_signature_validator";
function isValidThoughtSignature(signature) {
    if (!signature)
        return false;
    if (signature.length % 4 !== 0)
        return false;
    return base64SignaturePattern.test(signature);
}
/**
 * Only keep signatures from the same provider/model and with valid base64.
 */
function resolveThoughtSignature(isSameProviderAndModel, signature) {
    return isSameProviderAndModel && isValidThoughtSignature(signature) ? signature : undefined;
}
function getGeminiMajorVersion(modelId) {
    const match = modelId.toLowerCase().match(/^gemini(?:-live)?-(\d+)/);
    if (!match)
        return undefined;
    return Number.parseInt(match[1], 10);
}
/**
 * Models via Google APIs that require explicit tool call IDs in function calls/responses.
 * Gemini 3+ returns an id with every function call and matches responses by it.
 */
export function requiresToolCallId(modelId) {
    const geminiMajorVersion = getGeminiMajorVersion(modelId);
    return (modelId.startsWith("claude-") ||
        modelId.startsWith("gpt-oss-") ||
        (geminiMajorVersion !== undefined && geminiMajorVersion >= 3));
}
function supportsMultimodalFunctionResponse(modelId) {
    const geminiMajorVersion = getGeminiMajorVersion(modelId);
    if (geminiMajorVersion !== undefined) {
        return geminiMajorVersion >= 3;
    }
    return true;
}
/**
 * MIME types Gemini accepts inside `functionResponse.parts` (images and documents).
 * Audio and video tool output goes in a user turn after the function responses.
 */
function isFunctionResponsePartMime(mimeType) {
    const normalized = mimeType.toLowerCase();
    return normalized.startsWith("image/") || normalized === "application/pdf" || normalized === "text/plain";
}
function deferredToolMediaLabel(toolName, media) {
    const onlyImages = media.every((block) => block.mimeType.toLowerCase().startsWith("image/"));
    return onlyImages ? "Tool result image:" : `Tool result media from ${toolName}:`;
}
/**
 * Gemini 3+ validates thought signatures on every function-call step of the
 * current turn (everything after the last user message that is not a function
 * response) and rejects the request with 400 when the first call of a step is
 * unsigned. History from another model or provider carries no usable
 * signature, so sign those steps with the documented placeholder. Earlier
 * turns are not validated and stay untouched.
 */
function signUnsignedCurrentTurnCalls(contents, turnStart) {
    for (let i = turnStart; i < contents.length; i++) {
        const content = contents[i];
        if (content.role !== "model")
            continue;
        const firstCall = content.parts?.find((part) => part.functionCall);
        if (firstCall && !firstCall.thoughtSignature) {
            firstCall.thoughtSignature = SKIP_THOUGHT_SIGNATURE_VALIDATOR;
        }
    }
}
/** `functionResponse.response` key carrying user text that follows a run of tool results. */
const FUNCTION_RESPONSE_USER_MESSAGE_KEY = "user_message";
/**
 * Vertex AI Gemini 3.6+ rejects a user turn that puts text beside function responses
 * ("Requests ending with a model turn are not supported"), and opening a separate user
 * turn breaks role alternation (see `pushUserParts`). Text that follows tool results
 * (a host reminder or the next user message) therefore rides inside the last function
 * response, keeping the turn function-response only.
 * Returns false, leaving `content` untouched, when it is not a function-response-only
 * user turn or `parts` is not all text.
 */
function appendTextToFunctionResponses(content, parts) {
    if (content?.role !== "user" || !content.parts?.length)
        return false;
    if (!content.parts.every((part) => part.functionResponse))
        return false;
    if (!parts.every((part) => typeof part.text === "string"))
        return false;
    const functionResponse = content.parts[content.parts.length - 1].functionResponse;
    const response = { ...functionResponse.response };
    const previous = response[FUNCTION_RESPONSE_USER_MESSAGE_KEY];
    const texts = parts.map((part) => part.text);
    response[FUNCTION_RESPONSE_USER_MESSAGE_KEY] = (typeof previous === "string" ? [previous, ...texts] : texts).join("\n\n");
    functionResponse.response = response;
    return true;
}
/**
 * Convert internal messages to Gemini Content[] format.
 */
export function convertMessages(model, context) {
    const contents = [];
    const includeToolCallId = requiresToolCallId(model.id);
    const normalizeToolCallId = (id) => {
        if (!includeToolCallId)
            return id;
        return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
    };
    const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);
    // Gemini expects alternating roles: consecutive user contents (a tool result
    // followed by a user message, deferred media or a hidden reminder) make Gemini 3
    // intermittently answer with an empty STOP candidate, so every user-side part
    // joins the preceding user turn. User text after tool results goes inside the last
    // function response instead of beside it (see appendTextToFunctionResponses).
    const pushUserParts = (parts) => {
        const lastContent = contents[contents.length - 1];
        if (lastContent?.role === "user") {
            lastContent.parts = [...(lastContent.parts ?? []), ...parts];
        }
        else {
            contents.push({ role: "user", parts });
        }
    };
    // A user message opens a new Gemini turn unless its text was folded into the
    // preceding function responses; the wire then shows no new user text.
    const pushUserMessage = (parts) => {
        if (appendTextToFunctionResponses(contents[contents.length - 1], parts))
            return;
        pushUserParts(parts);
        currentTurnStart = contents.length;
    };
    // Tool media that cannot ride functionResponse.parts. Appended after the run of
    // tool results, so parallel function responses stay together and lead the turn.
    let deferredToolMedia = [];
    const flushDeferredToolMedia = () => {
        if (deferredToolMedia.length === 0)
            return;
        pushUserParts(deferredToolMedia);
        deferredToolMedia = [];
    };
    // The current turn starts after the content holding the last user message;
    // that content may also carry the previous turn's function responses.
    let currentTurnStart = 0;
    for (const msg of transformedMessages) {
        if (msg.role !== "toolResult")
            flushDeferredToolMedia();
        if (msg.role === "user") {
            if (typeof msg.content === "string") {
                pushUserMessage([{ text: sanitizeSurrogates(msg.content) }]);
            }
            else {
                const parts = msg.content.map((item) => {
                    if (item.type === "text") {
                        return { text: sanitizeSurrogates(item.text) };
                    }
                    else {
                        return {
                            inlineData: {
                                mimeType: item.mimeType,
                                data: item.data,
                            },
                        };
                    }
                });
                if (parts.length === 0)
                    continue;
                pushUserMessage(parts);
            }
        }
        else if (msg.role === "assistant") {
            const parts = [];
            // Check if message is from same provider and model - only then keep thinking blocks
            const isSameProviderAndModel = msg.provider === model.provider && msg.model === model.id;
            for (const block of msg.content) {
                if (block.type === "text") {
                    const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.textSignature);
                    // Skip empty text blocks unless they carry a thought signature: Gemini can attach the
                    // signature to a part whose visible text is empty and expects it echoed back.
                    if ((!block.text || block.text.trim() === "") && !thoughtSignature)
                        continue;
                    parts.push({
                        text: sanitizeSurrogates(block.text),
                        ...(thoughtSignature && { thoughtSignature }),
                    });
                }
                else if (block.type === "thinking") {
                    // Only keep as thinking block if same provider AND same model
                    // Otherwise convert to plain text (no tags to avoid model mimicking them)
                    if (isSameProviderAndModel) {
                        const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thinkingSignature);
                        // Same rule as text blocks: drop an empty thinking block only when it carries no signature.
                        if ((!block.thinking || block.thinking.trim() === "") && !thoughtSignature)
                            continue;
                        parts.push({
                            thought: true,
                            text: sanitizeSurrogates(block.thinking),
                            ...(thoughtSignature && { thoughtSignature }),
                        });
                    }
                    else {
                        // Cross-provider/model: the signature is unusable, empty blocks stay dropped.
                        if (!block.thinking || block.thinking.trim() === "")
                            continue;
                        parts.push({
                            text: sanitizeSurrogates(block.thinking),
                        });
                    }
                }
                else if (block.type === "toolCall") {
                    const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thoughtSignature);
                    const part = {
                        functionCall: {
                            name: block.name,
                            args: block.arguments ?? {},
                            ...(includeToolCallId ? { id: block.id } : {}),
                        },
                        ...(thoughtSignature && { thoughtSignature }),
                    };
                    parts.push(part);
                }
            }
            if (parts.length === 0)
                continue;
            contents.push({
                role: "model",
                parts,
            });
        }
        else if (msg.role === "toolResult") {
            // Extract text and image content
            const textContent = msg.content.filter((c) => c.type === "text");
            const textResult = textContent.map((c) => c.text).join("\n");
            const imageContent = model.input.includes("image")
                ? msg.content.filter((c) => c.type === "image")
                : [];
            const hasText = textResult.trim().length > 0;
            const hasImages = imageContent.length > 0;
            // Gemini 3+ models support multimodal function responses with images and documents
            // nested inside functionResponse.parts. Claude and other non-Gemini models behind
            // Cloud Code Assist keep that path; Gemini < 3 and audio/video media go in a user
            // turn after the function responses.
            const modelSupportsMultimodalFunctionResponse = supportsMultimodalFunctionResponse(model.id);
            // Use "output" key for success, "error" key for errors as per SDK documentation
            const responseValue = hasText ? sanitizeSurrogates(textResult) : hasImages ? "(see attached image)" : "";
            const toPart = (imageBlock) => ({
                inlineData: {
                    mimeType: imageBlock.mimeType,
                    data: imageBlock.data,
                },
            });
            const nestedImages = modelSupportsMultimodalFunctionResponse
                ? imageContent.filter((imageBlock) => isFunctionResponsePartMime(imageBlock.mimeType))
                : [];
            const deferredImages = imageContent.filter((imageBlock) => !nestedImages.includes(imageBlock));
            const functionResponsePart = {
                functionResponse: {
                    name: msg.toolName,
                    response: msg.isError ? { error: responseValue } : { output: responseValue },
                    ...(nestedImages.length > 0 && { parts: nestedImages.map(toPart) }),
                    ...(includeToolCallId ? { id: msg.toolCallId } : {}),
                },
            };
            // Cloud Code Assist API requires all function responses to be in a single user turn.
            pushUserParts([functionResponsePart]);
            if (deferredImages.length > 0) {
                deferredToolMedia.push({ text: deferredToolMediaLabel(msg.toolName, deferredImages) }, ...deferredImages.map(toPart));
            }
        }
    }
    flushDeferredToolMedia();
    // Gemini 3+ on the Gemini Developer API only (a Gemini id that requires tool call ids).
    if (model.api === "google-generative-ai" && includeToolCallId && getGeminiMajorVersion(model.id) !== undefined) {
        signUnsignedCurrentTurnCalls(contents, currentTurnStart);
    }
    return contents;
}
const JSON_SCHEMA_META_DECLARATIONS = new Set([
    "$schema",
    "$id",
    "$anchor",
    "$dynamicAnchor",
    "$vocabulary",
    "$comment",
    "$defs",
    "definitions", // pre-draft-2019-09 equivalent of $defs
]);
/**
 * Strip meta-declarations from a schema obj
 */
function sanitizeForOpenApi(schema) {
    if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
        return schema;
    }
    const result = {};
    for (const [key, value] of Object.entries(schema)) {
        if (JSON_SCHEMA_META_DECLARATIONS.has(key))
            continue;
        result[key] = sanitizeForOpenApi(value);
    }
    return result;
}
/** Schema keywords whose values map names to subschemas, so their keys are not schema keywords. */
const JSON_SCHEMA_NAME_MAPS = new Set([
    "properties",
    "patternProperties",
    "$defs",
    "definitions",
    "dependentSchemas",
    "dependencies",
]);
/** Keywords containing a subschema or an array of subschemas, not literal data. */
const JSON_SCHEMA_SUBSCHEMAS = new Set([
    "additionalProperties",
    "unevaluatedProperties",
    "propertyNames",
    "items",
    "prefixItems",
    "additionalItems",
    "unevaluatedItems",
    "contains",
    "allOf",
    "anyOf",
    "oneOf",
    "not",
    "if",
    "then",
    "else",
    "contentSchema",
]);
/**
 * Rewrite string and number `const` values to single-value `enum`s.
 * Gemini ignores `const` in `parametersJsonSchema` but honors `enum`.
 * Literal data (`default`, `examples`, `enum`, ...) is left untouched.
 */
function rewriteConstAsEnum(schema, isNameMap = false) {
    if (Array.isArray(schema))
        return schema.map((item) => rewriteConstAsEnum(item));
    if (typeof schema !== "object" || schema === null)
        return schema;
    // fromEntries preserves names such as __proto__ as own properties.
    const result = Object.fromEntries(Object.entries(schema).map(([key, value]) => {
        if (isNameMap || JSON_SCHEMA_SUBSCHEMAS.has(key))
            return [key, rewriteConstAsEnum(value)];
        if (JSON_SCHEMA_NAME_MAPS.has(key))
            return [key, rewriteConstAsEnum(value, true)];
        return [key, value];
    }));
    if (!isNameMap && "const" in result && result.enum === undefined) {
        const value = result.const;
        if (typeof value === "string" || typeof value === "number") {
            delete result.const;
            result.enum = [value];
        }
    }
    return result;
}
/**
 * Convert tools to Gemini function declarations format.
 *
 * By default uses `parametersJsonSchema` which supports full JSON Schema (including
 * anyOf, oneOf, etc.). Gemini ignores `const` there, so string and number `const`
 * values are sent as single-value `enum`s. Set `useParameters` to true to use the legacy
 * `parameters` field instead (OpenAPI 3.03 Schema). This is needed for Cloud Code Assist
 * with Claude models, where the API translates `parameters` into Anthropic's `input_schema`.
 */
export function convertTools(tools, useParameters = false) {
    if (tools.length === 0)
        return undefined;
    return [
        {
            functionDeclarations: tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                ...(useParameters
                    ? { parameters: sanitizeForOpenApi(tool.parameters) }
                    : { parametersJsonSchema: rewriteConstAsEnum(tool.parameters) }),
            })),
        },
    ];
}
/**
 * Map tool choice string to Gemini FunctionCallingConfigMode.
 */
export function mapToolChoice(choice) {
    switch (choice) {
        case "auto":
            return FunctionCallingConfigMode.AUTO;
        case "none":
            return FunctionCallingConfigMode.NONE;
        case "any":
            return FunctionCallingConfigMode.ANY;
        default:
            return FunctionCallingConfigMode.AUTO;
    }
}
/**
 * Map a Gemini finish reason to our StopReason.
 *
 * Accepts raw strings because the API adds finish reasons faster than the
 * pinned SDK enum (`CONTINUATION`, `TOO_MANY_TOOL_CALLS`,
 * `MISSING_THOUGHT_SIGNATURE`, `MALFORMED_RESPONSE`, ...). `CONTINUATION`
 * means the per-request output cap was reached, which pi reports as `length`.
 * Every other non-STOP reason is a provider-side failure.
 */
export function mapStopReason(reason) {
    switch (reason) {
        case FinishReason.STOP:
            return "stop";
        case FinishReason.MAX_TOKENS:
        case "CONTINUATION":
            return "length";
        default:
            return "error";
    }
}
/**
 * Map string finish reason to our StopReason (for raw API responses).
 */
export function mapStopReasonString(reason) {
    return mapStopReason(reason);
}
// Counter for generating unique tool call IDs
let toolCallCounter = 0;
/**
 * Consume a Gemini `streamGenerateContent` stream into pi assistant events.
 *
 * Shared by the Google Generative AI and Vertex adapters. Pushes `start`
 * through `done`; throws for aborts, missing finish reasons, prompt blocks and
 * provider-side stops so the adapter's catch block can emit the `error` event.
 */
export async function consumeGoogleStream(chunks, output, stream, model, options) {
    stream.push({ type: "start", partial: output });
    const blocks = output.content;
    const blockIndex = () => blocks.length - 1;
    let currentBlock = null;
    const endCurrentBlock = () => {
        if (!currentBlock)
            return;
        if (currentBlock.type === "text") {
            stream.push({ type: "text_end", contentIndex: blockIndex(), content: currentBlock.text, partial: output });
        }
        else {
            stream.push({
                type: "thinking_end",
                contentIndex: blockIndex(),
                content: currentBlock.thinking,
                partial: output,
            });
        }
        currentBlock = null;
    };
    let finishReason;
    let finishMessage;
    let blockReason;
    let responseObserved = false;
    for await (const chunk of withProviderEventObserver(chunks, options?.onProviderStreamEvent, model)) {
        if (!responseObserved) {
            responseObserved = true;
            const http = chunk.sdkHttpResponse;
            if (http && options?.onResponse) {
                await options.onResponse({ status: http.responseInternal?.status ?? 200, headers: http.headers ?? {} }, model);
            }
        }
        // @google/genai documents GenerateContentResponse.responseId as an output-only field
        // used to identify each response. Keep the first non-empty one from the stream.
        output.responseId ||= chunk.responseId;
        blockReason ??= chunk.promptFeedback?.blockReason;
        const candidate = chunk.candidates?.[0];
        for (const part of candidate?.content?.parts ?? []) {
            // A final `{text: ""}` part only closes the stream unless it carries the turn's signature.
            if (part.text !== undefined && (part.text !== "" || part.thoughtSignature)) {
                const isThinking = isThinkingPart(part);
                if (!currentBlock || currentBlock.type !== (isThinking ? "thinking" : "text")) {
                    endCurrentBlock();
                    const block = isThinking
                        ? { type: "thinking", thinking: "", thinkingSignature: undefined }
                        : { type: "text", text: "" };
                    currentBlock = block;
                    blocks.push(block);
                    stream.push({
                        type: isThinking ? "thinking_start" : "text_start",
                        contentIndex: blockIndex(),
                        partial: output,
                    });
                }
                const block = currentBlock;
                if (block.type === "thinking") {
                    block.thinking += part.text;
                    block.thinkingSignature = retainThoughtSignature(block.thinkingSignature, part.thoughtSignature);
                    if (part.text !== "") {
                        stream.push({
                            type: "thinking_delta",
                            contentIndex: blockIndex(),
                            delta: part.text,
                            partial: output,
                        });
                    }
                }
                else {
                    block.text += part.text;
                    block.textSignature = retainThoughtSignature(block.textSignature, part.thoughtSignature);
                    if (part.text !== "") {
                        stream.push({ type: "text_delta", contentIndex: blockIndex(), delta: part.text, partial: output });
                    }
                }
            }
            if (part.functionCall) {
                endCurrentBlock();
                // Generate unique ID if not provided or if it's a duplicate
                const providedId = part.functionCall.id;
                const needsNewId = !providedId || blocks.some((b) => b.type === "toolCall" && b.id === providedId);
                const toolCall = {
                    type: "toolCall",
                    id: needsNewId ? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}` : providedId,
                    name: part.functionCall.name || "",
                    arguments: part.functionCall.args ?? {},
                    ...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
                };
                blocks.push(toolCall);
                stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
                stream.push({
                    type: "toolcall_delta",
                    contentIndex: blockIndex(),
                    delta: JSON.stringify(toolCall.arguments),
                    partial: output,
                });
                stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
            }
        }
        if (candidate?.finishReason) {
            finishReason = candidate.finishReason;
            finishMessage = candidate.finishMessage;
        }
        // Usage is cumulative within a request. Some chunks carry only `trafficType`; skip those
        // so a partial message never reports zeroed counts.
        const usage = chunk.usageMetadata;
        if (usage && (usage.promptTokenCount !== undefined || usage.totalTokenCount !== undefined)) {
            const cacheRead = usage.cachedContentTokenCount ?? 0;
            // promptTokenCount includes cached tokens; tool-use prompt tokens (server-side tools,
            // agentic media) are billed as input but reported separately.
            const input = (usage.promptTokenCount ?? 0) - cacheRead + (usage.toolUsePromptTokenCount ?? 0);
            // candidatesTokenCount excludes thinking tokens, which are billed as output.
            const outputTokens = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
            output.usage = {
                input,
                output: outputTokens,
                cacheRead,
                cacheWrite: 0,
                totalTokens: usage.totalTokenCount ?? input + cacheRead + outputTokens,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            };
            calculateCost(model, output.usage);
        }
    }
    endCurrentBlock();
    if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
    }
    if (!finishReason) {
        throw new Error(blockReason ? `Prompt blocked by provider: ${blockReason}` : "Google stream ended without a finish reason");
    }
    const stopReason = mapStopReason(finishReason);
    if (stopReason === "error" || stopReason === "aborted") {
        throw new Error(`Provider stopped with: ${finishReason}${finishMessage ? ` (${finishMessage})` : ""}`);
    }
    const doneReason = stopReason === "stop" && blocks.some((b) => b.type === "toolCall") ? "toolUse" : stopReason;
    output.stopReason = doneReason;
    stream.push({ type: "done", reason: doneReason, message: output });
    stream.end();
}
//# sourceMappingURL=google-shared.js.map