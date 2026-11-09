import { convertToLlm } from '@earendil-works/pi-coding-agent/messages';
import { normalizeOutboundMessagesForModel, removeOrphanToolResults, } from '@mavis/agent-core/pi-turn-runner';
import { NON_VISION_TOOL_IMAGE_PLACEHOLDER, NON_VISION_USER_IMAGE_PLACEHOLDER, normalizeToolCallId, sanitizeSurrogates, toReferenceToolName, } from './messages-count-tokens-wire.js';
/**
 * Provider messages counted for `model`. Cross-model thinking follows the same
 * replay rule the main request uses (agent-core `normalizeOutboundMessagesForModel`).
 */
export function toProviderMessages(messages, model) {
    const compatible = removeOrphanToolResults(convertToLlm(messages));
    return normalizeOutboundMessagesForModel(compatible.messages, model).map((message) => {
        if (typeof message.content === 'string' || !Array.isArray(message.content))
            return message;
        let mutated = false;
        const content = message.content.map((block) => {
            if (!block || typeof block !== 'object')
                return block;
            const b = block;
            if (b.type !== 'video')
                return block;
            mutated = true;
            return {
                type: 'image',
                data: b.data,
                mimeType: b.mimeType,
            };
        });
        return mutated ? { ...message, content } : message;
    });
}
export function convertMessages(input) {
    const params = [];
    const transformedMessages = transformMessages(input.messages, input.model, normalizeToolCallId);
    for (let index = 0; index < transformedMessages.length; index += 1) {
        const converted = convertMessageAt(transformedMessages, index, input);
        if (!converted)
            continue;
        params.push(converted.message);
        index = converted.nextIndex;
    }
    applyCacheControl(params, input.cacheControl);
    return params;
}
function convertMessageAt(messages, index, input) {
    const message = messages[index];
    if (!message)
        return undefined;
    if (message.role === 'user') {
        const converted = convertUserMessage(message);
        return converted ? { message: converted, nextIndex: index } : undefined;
    }
    if (message.role === 'assistant') {
        const converted = convertAssistantMessage(message, input);
        return converted ? { message: converted, nextIndex: index } : undefined;
    }
    if (message.role === 'toolResult') {
        return convertToolResultMessages(messages, index);
    }
    return undefined;
}
function convertUserMessage(message) {
    if (typeof message.content === 'string') {
        return message.content.trim().length > 0
            ? { role: 'user', content: sanitizeSurrogates(message.content) }
            : undefined;
    }
    const blocks = message.content
        .map(convertUserContentBlock)
        .filter((block) => block.type !== 'text' || block.text.trim().length > 0);
    return blocks.length > 0 ? { role: 'user', content: blocks } : undefined;
}
function convertUserContentBlock(item) {
    if (item.type === 'text') {
        return { type: 'text', text: sanitizeSurrogates(item.text) };
    }
    return {
        type: 'image',
        source: {
            type: 'base64',
            media_type: item.mimeType,
            data: item.data,
        },
    };
}
function convertAssistantMessage(message, input) {
    const blocks = message.content.flatMap((block) => convertAssistantContentBlock(block, input));
    return blocks.length > 0 ? { role: 'assistant', content: blocks } : undefined;
}
function convertAssistantContentBlock(block, input) {
    if (block.type === 'text') {
        return block.text.trim().length > 0
            ? [{ type: 'text', text: sanitizeSurrogates(block.text) }]
            : [];
    }
    if (block.type === 'thinking')
        return convertThinkingBlock(block, input.allowEmptySignature === true);
    if (block.type !== 'toolCall')
        return [];
    return [
        {
            type: 'tool_use',
            id: block.id,
            name: input.isOAuthToken ? toReferenceToolName(block.name) : block.name,
            input: block.arguments ?? {},
        },
    ];
}
function convertThinkingBlock(block, allowEmptySignature) {
    if (block.redacted) {
        return [{ type: 'redacted_thinking', data: block.thinkingSignature }];
    }
    if (block.thinking.trim().length === 0)
        return [];
    if (block.thinkingSignature && block.thinkingSignature.trim().length > 0) {
        return [
            {
                type: 'thinking',
                thinking: sanitizeSurrogates(block.thinking),
                signature: block.thinkingSignature,
            },
        ];
    }
    return allowEmptySignature
        ? [
            {
                type: 'thinking',
                thinking: sanitizeSurrogates(block.thinking),
                signature: '',
            },
        ]
        : [{ type: 'text', text: sanitizeSurrogates(block.thinking) }];
}
function convertToolResultMessages(messages, index) {
    const first = messages[index];
    const toolResults = [convertToolResultBlock(first)];
    let nextIndex = index + 1;
    while (nextIndex < messages.length) {
        const next = messages[nextIndex];
        if (!next || next.role !== 'toolResult')
            break;
        toolResults.push(convertToolResultBlock(next));
        nextIndex += 1;
    }
    return {
        message: { role: 'user', content: toolResults },
        nextIndex: nextIndex - 1,
    };
}
function convertToolResultBlock(message) {
    return {
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: convertContentBlocks(message.content),
        is_error: message.isError,
    };
}
function applyCacheControl(params, cacheControl) {
    if (!cacheControl || params.length === 0)
        return;
    const lastMessage = params[params.length - 1];
    if (!lastMessage || lastMessage.role !== 'user')
        return;
    if (Array.isArray(lastMessage.content)) {
        const lastBlock = lastMessage.content.at(-1);
        if (lastBlock?.type === 'text' ||
            lastBlock?.type === 'image' ||
            lastBlock?.type === 'tool_result')
            lastBlock.cache_control = cacheControl;
        return;
    }
    lastMessage.content = [{ type: 'text', text: lastMessage.content, cache_control: cacheControl }];
}
function convertContentBlocks(content) {
    const hasImages = content.some((block) => block.type === 'image');
    if (!hasImages)
        return sanitizeSurrogates(content.map((block) => block.text).join('\n'));
    const blocks = content.map((block) => {
        if (block.type === 'text')
            return { type: 'text', text: sanitizeSurrogates(block.text) };
        return {
            type: 'image',
            source: {
                type: 'base64',
                media_type: block.mimeType,
                data: block.data,
            },
        };
    });
    if (!blocks.some((block) => block.type === 'text')) {
        blocks.unshift({ type: 'text', text: '(see attached image)' });
    }
    return blocks;
}
export function convertTools(tools, isOAuthToken, supportsEagerToolInputStreaming, cacheControl) {
    return tools.map((tool, index) => {
        const schema = tool.parameters;
        return {
            name: isOAuthToken ? toReferenceToolName(tool.name) : tool.name,
            description: tool.description,
            ...(supportsEagerToolInputStreaming ? { eager_input_streaming: true } : {}),
            input_schema: {
                type: 'object',
                properties: schema.properties ?? {},
                required: schema.required ?? [],
            },
            ...(cacheControl && index === tools.length - 1 ? { cache_control: cacheControl } : {}),
        };
    });
}
function transformAssistantMessage(message, model, normalizeToolCallIdFn, toolCallIdMap) {
    const isSameModel = message.provider === model.provider && message.api === model.api && message.model === model.id;
    const content = message.content.flatMap((block) => transformAssistantBlock(block, isSameModel, normalizeToolCallIdFn, toolCallIdMap));
    return { ...message, content };
}
function transformAssistantBlock(block, isSameModel, normalizeToolCallIdFn, toolCallIdMap) {
    if (block.type === 'thinking')
        return transformThinkingBlock(block, isSameModel);
    if (block.type === 'text')
        return [{ type: 'text', text: block.text }];
    if (block.type !== 'toolCall')
        return [block];
    return [normalizeToolCall(block, isSameModel, normalizeToolCallIdFn, toolCallIdMap)];
}
function transformThinkingBlock(block, isSameModel) {
    if (block.redacted)
        return isSameModel ? [block] : [];
    if (isSameModel && block.thinkingSignature)
        return [block];
    if (!block.thinking || block.thinking.trim() === '')
        return [];
    return isSameModel ? [block] : [{ type: 'text', text: block.thinking }];
}
function normalizeToolCall(toolCall, isSameModel, normalizeToolCallIdFn, toolCallIdMap) {
    let normalizedToolCall = toolCall;
    if (!isSameModel && toolCall.thoughtSignature) {
        normalizedToolCall = { ...toolCall };
        delete normalizedToolCall.thoughtSignature;
    }
    if (!isSameModel && normalizeToolCallIdFn) {
        const normalizedId = normalizeToolCallIdFn(toolCall.id);
        if (normalizedId !== toolCall.id) {
            toolCallIdMap.set(toolCall.id, normalizedId);
            normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
        }
    }
    return normalizedToolCall;
}
function transformMessages(messages, model, normalizeToolCallIdFn) {
    const toolCallIdMap = new Map();
    const imageAwareMessages = downgradeUnsupportedImages(messages, model);
    const transformed = imageAwareMessages.map((msg) => {
        if (msg.role === 'user')
            return msg;
        if (msg.role === 'toolResult') {
            const normalizedId = toolCallIdMap.get(msg.toolCallId);
            return normalizedId && normalizedId !== msg.toolCallId
                ? { ...msg, toolCallId: normalizedId }
                : msg;
        }
        if (msg.role !== 'assistant')
            return msg;
        return transformAssistantMessage(msg, model, normalizeToolCallIdFn, toolCallIdMap);
    });
    const result = [];
    let pendingToolCalls = [];
    let existingToolResultIds = new Set();
    const insertSyntheticToolResults = () => {
        if (pendingToolCalls.length === 0)
            return;
        for (const toolCall of pendingToolCalls) {
            if (!existingToolResultIds.has(toolCall.id)) {
                result.push({
                    role: 'toolResult',
                    toolCallId: toolCall.id,
                    toolName: toolCall.name,
                    content: [{ type: 'text', text: 'No result provided' }],
                    isError: true,
                    timestamp: Date.now(),
                });
            }
        }
        pendingToolCalls = [];
        existingToolResultIds = new Set();
    };
    for (const msg of transformed) {
        if (msg.role === 'assistant') {
            insertSyntheticToolResults();
            const assistantMsg = msg;
            if (assistantMsg.stopReason === 'error' || assistantMsg.stopReason === 'aborted')
                continue;
            const toolCalls = assistantMsg.content.filter((block) => block.type === 'toolCall');
            if (toolCalls.length > 0) {
                pendingToolCalls = toolCalls;
                existingToolResultIds = new Set();
            }
            result.push(msg);
        }
        else if (msg.role === 'toolResult') {
            existingToolResultIds.add(msg.toolCallId);
            result.push(msg);
        }
        else if (msg.role === 'user') {
            insertSyntheticToolResults();
            result.push(msg);
        }
        else {
            result.push(msg);
        }
    }
    insertSyntheticToolResults();
    return result;
}
function downgradeUnsupportedImages(messages, model) {
    if (model.input.includes('image'))
        return messages;
    return messages.map((msg) => {
        if (msg.role === 'user' && Array.isArray(msg.content)) {
            return {
                ...msg,
                content: replaceImagesWithPlaceholder(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER),
            };
        }
        if (msg.role === 'toolResult') {
            return {
                ...msg,
                content: replaceImagesWithPlaceholder(msg.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER),
            };
        }
        return msg;
    });
}
function replaceImagesWithPlaceholder(content, placeholder) {
    const result = [];
    let previousWasPlaceholder = false;
    for (const block of content) {
        if (block.type === 'image') {
            if (!previousWasPlaceholder)
                result.push({ type: 'text', text: placeholder });
            previousWasPlaceholder = true;
            continue;
        }
        result.push(block);
        previousWasPlaceholder = block.text === placeholder;
    }
    return result;
}
//# sourceMappingURL=messages-count-tokens-messages.js.map