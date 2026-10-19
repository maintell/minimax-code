import { isInlineBinaryContentBlock, sanitizeWireToolCallResultData, } from '@mavis/agent-core/event-bridge';
export function isInlineDisplayDataUrl(value) {
    return typeof value === 'string' && /^data:/iu.test(value.trimStart());
}
export function sanitizeDisplayAttachment(value) {
    if (Array.isArray(value))
        return value.map(sanitizeDisplayAttachment);
    if (!isRecord(value))
        return value;
    const binaryBlock = isInlineBinaryContentBlock(value);
    return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
        if (isInlineDisplayDataUrl(entry))
            return [];
        if (key === 'data' && binaryBlock)
            return [];
        return [[key, sanitizeDisplayAttachment(entry)]];
    }));
}
export function sanitizeDisplayMessageRecord(message) {
    const attachments = Array.isArray(message.attachments)
        ? message.attachments.map(sanitizeDisplayAttachment)
        : undefined;
    const toolCalls = Array.isArray(message.tool_calls)
        ? message.tool_calls.map(sanitizeDisplayToolCall)
        : undefined;
    const camelToolCalls = Array.isArray(message.toolCalls)
        ? message.toolCalls.map(sanitizeDisplayToolCall)
        : undefined;
    if (!attachments && !toolCalls && !camelToolCalls)
        return message;
    return {
        ...message,
        ...(attachments ? { attachments } : {}),
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
        ...(camelToolCalls ? { toolCalls: camelToolCalls } : {}),
    };
}
function sanitizeDisplayToolCall(value) {
    if (!isRecord(value))
        return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
        if (!isToolCallResultKey(key))
            return [key, entry];
        return [
            key,
            typeof entry === 'string'
                ? sanitizeToolResultJson(entry)
                : sanitizeDisplayAttachment(entry),
        ];
    }));
}
function sanitizeToolResultJson(raw) {
    const sanitized = sanitizeWireToolCallResultData(raw);
    if (sanitized === raw && !raw.toLowerCase().includes('data:'))
        return raw;
    try {
        return JSON.stringify(sanitizeDisplayAttachment(JSON.parse(sanitized)));
    }
    catch {
        return sanitized;
    }
}
function isToolCallResultKey(key) {
    return [
        'tool_call_result_data',
        'tool_call_result_data_json',
        'toolCallResultData',
        'toolCallResultDataJson',
    ].includes(key);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=display-binary-sanitizer.js.map