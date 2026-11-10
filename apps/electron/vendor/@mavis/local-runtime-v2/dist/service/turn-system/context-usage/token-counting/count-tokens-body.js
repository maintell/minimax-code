import { buildMessagesCountTokensRequestBody, } from './messages-count-tokens-payload.js';
import { estimateImageBlockTokens } from './image-detection.js';
function safeJsonStringify(value) {
    try {
        return JSON.stringify(value) ?? '';
    }
    catch {
        return '[unserializable]';
    }
}
export function buildCountTokensRequestBody(input) {
    return buildMessagesCountTokensRequestBody(input);
}
/**
 * 请求体里是否带 base64 图片/视频块（用户消息或 tool_result 内嵌）。
 * 保留给 adapter/request-shape 检查；remote counter 不会因此触发上传。
 */
export function countTokensBodyHasImages(body) {
    return (body.messages ?? []).some((message) => messageHasBase64Media(message));
}
function messageHasBase64Media(message) {
    if (typeof message.content === 'string')
        return false;
    return message.content.some((block) => isBase64MediaBlock(block) ||
        (block.type === 'tool_result' &&
            Array.isArray(block.content) &&
            block.content.some((nested) => isBase64MediaBlock(nested))));
}
function isBase64MediaBlock(block) {
    const type = block?.type;
    return type === 'image' || type === 'video';
}
const CJK_RE = /[\u{3000}-\u{303F}\u{3040}-\u{30FF}\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{F900}-\u{FAFF}\u{FF00}-\u{FFEF}\u{AC00}-\u{D7AF}\u{20000}-\u{2FA1F}]/u;
function estimateCharsToTokensCjkAware(text) {
    if (!text)
        return 0;
    let cjk = 0;
    let other = 0;
    for (const ch of text) {
        if (CJK_RE.test(ch))
            cjk += 1;
        else
            other += 1;
    }
    return cjk + Math.ceil(other / 4);
}
function estimateMessagesPayloadTokens(value, model) {
    if (typeof value === 'string')
        return estimateCharsToTokensCjkAware(value);
    if (typeof value === 'number' || typeof value === 'boolean') {
        return estimateCharsToTokensCjkAware(String(value));
    }
    if (!value)
        return 0;
    if (Array.isArray(value)) {
        return value.reduce((total, item) => total + estimateMessagesPayloadTokens(item, model), 0);
    }
    if (typeof value !== 'object')
        return 0;
    return estimateStructuredPayloadTokens(value, model);
}
function estimateStructuredPayloadTokens(record, model) {
    if (record.type === 'image' || record.type === 'video') {
        return estimateImageBlockTokens(record, { model });
    }
    if (record.type === 'text')
        return estimateMessagesPayloadTokens(record.text, model);
    if (record.type === 'thinking') {
        return estimateMessagesPayloadTokens(record.thinking, model) + estimateMessagesPayloadTokens(record.signature, model);
    }
    if (record.type === 'redacted_thinking')
        return estimateMessagesPayloadTokens(record.data, model);
    if (record.type === 'tool_use') {
        return estimateMessagesPayloadTokens(record.id, model) + estimateMessagesPayloadTokens(record.name, model) + estimateCharsToTokensCjkAware(safeJsonStringify(record.input));
    }
    if (record.type === 'tool_result') {
        return estimateMessagesPayloadTokens(record.tool_use_id, model) + estimateMessagesPayloadTokens(record.content, model) + estimateMessagesPayloadTokens(record.is_error, model);
    }
    return Object.entries(record)
        .filter(([key]) => key !== 'data' && key !== 'source' && key !== 'cache_control')
        .reduce((total, [, nested]) => total + estimateMessagesPayloadTokens(nested, model), 0);
}
//# sourceMappingURL=count-tokens-body.js.map