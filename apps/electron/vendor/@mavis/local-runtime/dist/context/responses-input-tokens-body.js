import { convertResponsesMessages, convertResponsesTools } from '@earendil-works/pi-ai';
import { thinkingToPortableText, toProviderMessages } from './messages-count-tokens-messages.js';
const OPENAI_RESPONSES_TOOL_CALL_PROVIDERS = new Set(['openai', 'openai-codex', 'opencode']);
export function buildResponsesInputTokensRequestBody(messages, systemPrompt, model, tools) {
    const context = {
        systemPrompt,
        messages: normalizeResponsesThinking(toProviderMessages(messages, model)),
        tools,
    };
    const allowedToolCallProviders = new Set(OPENAI_RESPONSES_TOOL_CALL_PROVIDERS);
    if (model.provider)
        allowedToolCallProviders.add(model.provider);
    const body = {
        model: model.id,
        input: convertResponsesMessages(model, context, allowedToolCallProviders),
    };
    if (tools && tools.length > 0) {
        body.tools = convertResponsesTools(tools);
    }
    return body;
}
function normalizeResponsesThinking(messages) {
    return messages.map((message) => {
        if (message.role !== 'assistant')
            return message;
        let changed = false;
        const content = message.content.flatMap((block) => {
            if (block.type !== 'thinking' || isResponsesReasoningSignature(block.thinkingSignature)) {
                return block;
            }
            changed = true;
            return thinkingToPortableText(block);
        });
        return changed ? { ...message, content } : message;
    });
}
function isResponsesReasoningSignature(signature) {
    if (!signature)
        return false;
    try {
        const parsed = JSON.parse(signature);
        return (parsed !== null &&
            typeof parsed === 'object' &&
            !Array.isArray(parsed) &&
            parsed.type === 'reasoning');
    }
    catch {
        return false;
    }
}
export function responsesInputTokensBodyHasImages(body) {
    return hasInputImage(body.input);
}
export function responsesInputTokensBodyHasVideo(body) {
    return hasInputVideo(body.input);
}
function hasInputImage(value) {
    if (!value || typeof value !== 'object')
        return false;
    if (Array.isArray(value))
        return value.some((item) => hasInputImage(item));
    const record = value;
    if (record.type === 'input_image')
        return true;
    return Object.values(record).some((nested) => hasInputImage(nested));
}
function hasInputVideo(value) {
    if (!value || typeof value !== 'object')
        return false;
    if (Array.isArray(value))
        return value.some((item) => hasInputVideo(item));
    const record = value;
    if (record.type === 'input_image' &&
        typeof record.image_url === 'string' &&
        record.image_url.toLowerCase().startsWith('data:video/')) {
        return true;
    }
    return Object.values(record).some((nested) => hasInputVideo(nested));
}
//# sourceMappingURL=responses-input-tokens-body.js.map