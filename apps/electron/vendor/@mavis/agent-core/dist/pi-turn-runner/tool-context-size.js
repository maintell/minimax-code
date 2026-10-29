const UNSERIALIZABLE_PLACEHOLDER = '[unserializable]';
const TOOL_CONTEXT_TOKEN_BUCKETS = [
    16, 64, 256, 1_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000,
];
const TOOL_CONTEXT_BYTE_BUCKETS = [
    64, 256, 1_000, 4_000, 16_000, 64_000, 256_000, 1_000_000, 4_000_000, 16_000_000,
];
export function createToolContextHistogramBucketsByName() {
    return {
        pi_tool_operation_result_tokens: [...TOOL_CONTEXT_TOKEN_BUCKETS],
        pi_tool_io_bytes: [...TOOL_CONTEXT_BYTE_BUCKETS],
        pi_tool_operation_result_bytes: [...TOOL_CONTEXT_BYTE_BUCKETS],
        pi_tool_context_resident_bytes: [...TOOL_CONTEXT_BYTE_BUCKETS],
    };
}
function safeJsonStringify(value) {
    try {
        return JSON.stringify(value) ?? 'undefined';
    }
    catch {
        return UNSERIALIZABLE_PLACEHOLDER;
    }
}
function measureText(text, estimator) {
    const measured = { bytes: Buffer.byteLength(text, 'utf8') };
    if (!estimator)
        return measured;
    try {
        const tokens = estimator.estimateTextTokens(text);
        if (Number.isFinite(tokens) && tokens >= 0)
            measured.tokens = tokens;
    }
    catch {
        // Observability is fail-open: retain the byte count and omit tokens.
    }
    return measured;
}
export function measureToolArguments(value, estimator) {
    return measureText(safeJsonStringify(value), estimator);
}
export function measureToolResult(value, estimator) {
    const content = extractResultContent(value);
    if (typeof content === 'string')
        return measureText(content, estimator);
    if (!Array.isArray(content))
        return measureText('', estimator);
    let bytes = 0;
    let tokens = estimator ? 0 : undefined;
    for (const rawBlock of content) {
        if (!rawBlock || typeof rawBlock !== 'object')
            continue;
        const block = rawBlock;
        if (block.type === 'text' && typeof block.text === 'string') {
            const measured = measureText(block.text, estimator);
            bytes += measured.bytes;
            tokens = mergeTokens(tokens, measured.tokens);
        }
        else if (block.type === 'image' || block.type === 'video') {
            if (typeof block.data === 'string')
                bytes += Buffer.byteLength(block.data, 'utf8');
            if (tokens !== undefined && estimator) {
                try {
                    const visualTokens = estimator.estimateVisualTokens();
                    tokens =
                        Number.isFinite(visualTokens) && visualTokens >= 0 ? tokens + visualTokens : undefined;
                }
                catch {
                    tokens = undefined;
                }
            }
        }
    }
    return tokens === undefined ? { bytes } : { bytes, tokens };
}
export function measureToolContext(messages, estimator, normalizeToolName = (toolName) => toolName) {
    const toolNamesByCallId = new Map();
    const breakdown = {
        argumentBytes: 0,
        ...(estimator ? { argumentTokens: 0 } : {}),
        resultBytes: 0,
        ...(estimator ? { resultTokens: 0 } : {}),
        itemCount: 0,
        byTool: new Map(),
    };
    for (const message of messages) {
        if (message.role === 'assistant') {
            const content = message.content;
            if (!Array.isArray(content))
                continue;
            for (const rawBlock of content) {
                if (!rawBlock || typeof rawBlock !== 'object')
                    continue;
                const block = rawBlock;
                if (block.type !== 'toolCall' || typeof block.name !== 'string')
                    continue;
                const toolName = safeNormalizeToolName(block.name, normalizeToolName);
                if (typeof block.id === 'string')
                    toolNamesByCallId.set(block.id, toolName);
                addMeasurement(breakdown, toolName, 'arguments', measureToolArguments(block.arguments, estimator), estimator !== undefined);
            }
            continue;
        }
        if (message.role === 'toolResult') {
            const result = message;
            const toolName = typeof result.toolCallId === 'string'
                ? (toolNamesByCallId.get(result.toolCallId) ?? 'unknown')
                : 'unknown';
            addMeasurement(breakdown, toolName, 'result', measureToolResult(message, estimator), estimator !== undefined);
        }
    }
    return breakdown;
}
function extractResultContent(value) {
    if (typeof value === 'string' || Array.isArray(value))
        return value;
    if (!value || typeof value !== 'object')
        return '';
    return value.content ?? '';
}
function safeNormalizeToolName(toolName, normalizeToolName) {
    try {
        const normalized = normalizeToolName(toolName);
        return normalized || 'unknown';
    }
    catch {
        return 'unknown';
    }
}
function emptyContribution(withTokens) {
    return {
        argumentBytes: 0,
        ...(withTokens ? { argumentTokens: 0 } : {}),
        resultBytes: 0,
        ...(withTokens ? { resultTokens: 0 } : {}),
    };
}
function addMeasurement(breakdown, toolName, kind, measured, withTokens) {
    const contribution = breakdown.byTool.get(toolName) ?? emptyContribution(withTokens);
    const bytesKey = kind === 'arguments' ? 'argumentBytes' : 'resultBytes';
    const tokensKey = kind === 'arguments' ? 'argumentTokens' : 'resultTokens';
    breakdown[bytesKey] += measured.bytes;
    contribution[bytesKey] += measured.bytes;
    breakdown[tokensKey] = mergeTokens(breakdown[tokensKey], measured.tokens);
    contribution[tokensKey] = mergeTokens(contribution[tokensKey], measured.tokens);
    breakdown.byTool.set(toolName, contribution);
    breakdown.itemCount += 1;
    const candidate = {
        kind,
        toolName,
        bytes: measured.bytes,
        ...(measured.tokens !== undefined ? { tokens: measured.tokens } : {}),
    };
    if (!breakdown.largest || measurementScore(candidate) > measurementScore(breakdown.largest)) {
        breakdown.largest = candidate;
    }
}
function mergeTokens(current, next) {
    if (current === undefined || next === undefined)
        return undefined;
    return current + next;
}
function measurementScore(value) {
    return value.tokens ?? value.bytes;
}
//# sourceMappingURL=tool-context-size.js.map