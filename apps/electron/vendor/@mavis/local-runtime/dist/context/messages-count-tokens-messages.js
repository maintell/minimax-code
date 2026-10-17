import { convertToLlm } from '@earendil-works/pi-coding-agent/messages';
import { removeOrphanToolResults } from '@mavis/agent-core/pi-turn-runner';
import { NON_VISION_TOOL_IMAGE_PLACEHOLDER, NON_VISION_USER_IMAGE_PLACEHOLDER, PRIOR_THINKING_CLOSE, PRIOR_THINKING_OPEN, SIBLING_NATIVE_THINKING_APIS, normalizeToolCallId, sanitizeSurrogates, toReferenceToolName, } from './messages-count-tokens-wire.js';
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
function normalizeOutboundMessagesForModel(messages, targetModel) {
    return messages.map((message) => {
        if (message.role !== 'assistant')
            return message;
        return normalizeAssistantMessage(message, targetModel);
    });
}
function normalizeAssistantMessage(message, targetModel) {
    const sameProviderAndApi = message.provider === targetModel.provider && message.api === targetModel.api;
    const sameModel = sameProviderAndApi && message.model === targetModel.id;
    if (sameModel)
        return message;
    const canReplayNativeSibling = sameProviderAndApi && SIBLING_NATIVE_THINKING_APIS.has(targetModel.api);
    const content = message.content.flatMap((block) => {
        if (block.type !== 'thinking')
            return block;
        if (canReplayNativeSibling)
            return block;
        return thinkingToPortableText(block);
    });
    if (!canReplayNativeSibling)
        return { ...message, content };
    return {
        ...message,
        model: targetModel.id,
        content,
    };
}
export function thinkingToPortableText(block) {
    if (block.redacted || !block.thinking || block.thinking.trim().length === 0)
        return [];
    return [
        {
            type: 'text',
            text: `${PRIOR_THINKING_OPEN}\n${block.thinking}\n${PRIOR_THINKING_CLOSE}`,
        },
    ];
}
export function convertMessages(messages, model, isOAuthToken, cacheControl, allowEmptySignature = false) {
    const params = [];
    const transformedMessages = transformMessages(messages, model, normalizeToolCallId);
    for (let i = 0; i < transformedMessages.length; i += 1) {
        const msg = transformedMessages[i];
        if (msg.role === 'user') {
            if (typeof msg.content === 'string') {
                if (msg.content.trim().length > 0)
                    params.push({ role: 'user', content: sanitizeSurrogates(msg.content) });
            }
            else {
                const blocks = msg.content.map((item) => {
                    if (item.type === 'text')
                        return { type: 'text', text: sanitizeSurrogates(item.text) };
                    return {
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: item.mimeType,
                            data: item.data,
                        },
                    };
                });
                const filteredBlocks = blocks.filter((block) => block.type !== 'text' || block.text.trim().length > 0);
                if (filteredBlocks.length > 0)
                    params.push({ role: 'user', content: filteredBlocks });
            }
        }
        else if (msg.role === 'assistant') {
            const blocks = [];
            for (const block of msg.content) {
                if (block.type === 'text') {
                    if (block.text.trim().length > 0)
                        blocks.push({ type: 'text', text: sanitizeSurrogates(block.text) });
                }
                else if (block.type === 'thinking') {
                    if (block.redacted) {
                        blocks.push({ type: 'redacted_thinking', data: block.thinkingSignature });
                    }
                    else if (block.thinking.trim().length > 0) {
                        if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
                            blocks.push(allowEmptySignature
                                ? {
                                    type: 'thinking',
                                    thinking: sanitizeSurrogates(block.thinking),
                                    signature: '',
                                }
                                : { type: 'text', text: sanitizeSurrogates(block.thinking) });
                        }
                        else {
                            blocks.push({
                                type: 'thinking',
                                thinking: sanitizeSurrogates(block.thinking),
                                signature: block.thinkingSignature,
                            });
                        }
                    }
                }
                else if (block.type === 'toolCall') {
                    blocks.push({
                        type: 'tool_use',
                        id: block.id,
                        name: isOAuthToken ? toReferenceToolName(block.name) : block.name,
                        input: (block.arguments ?? {}),
                    });
                }
            }
            if (blocks.length > 0)
                params.push({ role: 'assistant', content: blocks });
        }
        else if (msg.role === 'toolResult') {
            const toolResults = [
                {
                    type: 'tool_result',
                    tool_use_id: msg.toolCallId,
                    content: convertContentBlocks(msg.content),
                    is_error: msg.isError,
                },
            ];
            let j = i + 1;
            while (j < transformedMessages.length && transformedMessages[j]?.role === 'toolResult') {
                const nextMsg = transformedMessages[j];
                toolResults.push({
                    type: 'tool_result',
                    tool_use_id: nextMsg.toolCallId,
                    content: convertContentBlocks(nextMsg.content),
                    is_error: nextMsg.isError,
                });
                j += 1;
            }
            i = j - 1;
            params.push({ role: 'user', content: toolResults });
        }
    }
    if (cacheControl && params.length > 0) {
        const lastMessage = params[params.length - 1];
        if (lastMessage.role === 'user') {
            if (Array.isArray(lastMessage.content)) {
                const lastBlock = lastMessage.content[lastMessage.content.length - 1];
                if (lastBlock &&
                    (lastBlock.type === 'text' ||
                        lastBlock.type === 'image' ||
                        lastBlock.type === 'tool_result')) {
                    lastBlock.cache_control = cacheControl;
                }
            }
            else if (typeof lastMessage.content === 'string') {
                lastMessage.content = [
                    { type: 'text', text: lastMessage.content, cache_control: cacheControl },
                ];
            }
        }
    }
    return params;
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
        const assistantMsg = msg;
        const isSameModel = assistantMsg.provider === model.provider &&
            assistantMsg.api === model.api &&
            assistantMsg.model === model.id;
        const transformedContent = assistantMsg.content.flatMap((block) => {
            if (block.type === 'thinking') {
                if (block.redacted)
                    return isSameModel ? block : [];
                if (isSameModel && block.thinkingSignature)
                    return block;
                if (!block.thinking || block.thinking.trim() === '')
                    return [];
                if (isSameModel)
                    return block;
                return { type: 'text', text: block.thinking };
            }
            if (block.type === 'text')
                return { type: 'text', text: block.text };
            if (block.type !== 'toolCall')
                return block;
            const toolCall = block;
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
        });
        return { ...assistantMsg, content: transformedContent };
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