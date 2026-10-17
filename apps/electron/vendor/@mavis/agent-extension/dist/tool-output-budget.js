import { isSourceReferenceMarkerBlock } from './source-reference-marker.js';
/**
 * Externalizes oversized textual tool output while leaving media blocks in
 * the model-visible result. Artifact storage, access control, retention and
 * cleanup stay behind the injected writer owned by the host.
 */
export function toolOutputBudgetExtension(options) {
    const defaultMaxInlineBytes = positiveInteger(options.maxInlineBytes, 'maxInlineBytes');
    const fallbackPreviewBytes = positiveInteger(options.fallbackPreviewBytes ?? Math.min(defaultMaxInlineBytes, 2_048), 'fallbackPreviewBytes');
    const perTool = normalizePerToolLimits(options.perToolMaxInlineBytes);
    const sensitiveTools = new Set(options.sensitiveTools ?? []);
    const afterToolCall = async (toolContext, _signal, turnCtx) => {
        // A receipt is only a safe replacement when this exact turn can recover
        // the archived result. Keep the original ToolResult otherwise.
        if (!toolContext.context.tools?.some((tool) => tool.name === 'read'))
            return undefined;
        const textBlocks = toolContext.result.content.filter((block) => block.type === 'text');
        if (textBlocks.length === 0)
            return undefined;
        // Count every text byte, including host-generated markers.
        const text = textBlocks.map((block) => block.text).join('\n');
        const originalBytes = Buffer.byteLength(text);
        const toolName = toolContext.toolCall.name;
        const limit = perTool.get(toolName) ??
            readLiveMaxInlineBytes(options.getMaxInlineBytes, defaultMaxInlineBytes);
        if (originalBytes <= limit)
            return undefined;
        const sourceMarkerBlocks = boundedSourceReferenceMarkers(textBlocks, Math.min(limit, 4_096));
        const retainedMarkers = new Set(sourceMarkerBlocks);
        // Keep original structured payloads parseable. Bounded host hints stay in
        // context; every other block (including oversized hints) is archived.
        const artifactText = textBlocks
            .filter((block) => !retainedMarkers.has(block))
            .map((block) => block.text)
            .join('\n');
        const artifactInput = buildArtifactInput(turnCtx, toolContext.toolCall.id, toolName, toolContext.args, artifactText, originalBytes, sensitiveTools.has(toolName));
        const mediaBlocks = toolContext.result.content.filter((block) => block.type !== 'text');
        try {
            const artifact = await options.writeArtifact(artifactInput);
            const receipt = buildExternalizedReceipt({
                artifact,
                toolName,
                args: toolContext.args,
                isError: toolContext.isError,
            });
            return {
                // Preserve only bounded, host-created citation hints after archiving.
                content: [{ type: 'text', text: receipt }, ...sourceMarkerBlocks, ...mediaBlocks],
                details: mergeBudgetDetails(toolContext.result.details, {
                    externalized: true,
                    fallback: false,
                    original_bytes: originalBytes,
                    reference: artifact.reference,
                    ...(artifact.metadata ?? {}),
                }),
            };
        }
        catch (error) {
            await notifyArtifactError(options.onArtifactError, error, artifactInput);
            const notice = `\n\n[tool output truncated: ${originalBytes} bytes; artifact persistence failed]\n\n`;
            return {
                content: [
                    { type: 'text', text: headTailPreview(text, fallbackPreviewBytes, notice) },
                    ...mediaBlocks,
                ],
                details: mergeBudgetDetails(toolContext.result.details, {
                    externalized: false,
                    fallback: true,
                    original_bytes: originalBytes,
                }),
            };
        }
    };
    return {
        id: options.id ?? 'tool-output-budget',
        description: options.description ??
            'Externalize oversized textual tool results and replace them with a recovery receipt.',
        init(pi) {
            pi.on('after_tool_call', afterToolCall);
        },
    };
}
function boundedSourceReferenceMarkers(textBlocks, limit) {
    const sourceMarkerBlocks = [];
    let remainingBytes = limit;
    textBlocks.forEach((block) => {
        if (!isSourceReferenceMarkerBlock(block))
            return;
        const bytes = Buffer.byteLength(block.text) + 1;
        if (bytes > remainingBytes)
            return;
        remainingBytes -= bytes;
        sourceMarkerBlocks.push(block);
    });
    return sourceMarkerBlocks;
}
function buildArtifactInput(ctx, toolCallId, toolName, args, text, originalBytes, sensitive) {
    return {
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        agentName: ctx.agentName,
        workspaceDir: ctx.workspaceDir,
        toolCallId,
        toolName,
        args,
        text,
        originalBytes,
        sensitive,
    };
}
function positiveInteger(value, field) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`toolOutputBudgetExtension: ${field} must be a positive integer`);
    }
    return value;
}
function readLiveMaxInlineBytes(getMaxInlineBytes, fallback) {
    try {
        const value = getMaxInlineBytes?.();
        return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
    }
    catch {
        return fallback;
    }
}
function normalizePerToolLimits(limits) {
    const normalized = new Map();
    for (const [toolName, value] of Object.entries(limits ?? {})) {
        normalized.set(toolName, positiveInteger(value, `perToolMaxInlineBytes.${toolName}`));
    }
    return normalized;
}
function headTailPreview(text, budgetBytes, notice) {
    const headBytes = Math.ceil(budgetBytes / 2);
    const tailBytes = Math.floor(budgetBytes / 2);
    return `${takeUtf8Start(text, headBytes)}${notice}${takeUtf8End(text, tailBytes)}`;
}
function takeUtf8Start(text, budgetBytes) {
    let used = 0;
    let result = '';
    for (const char of text) {
        const bytes = Buffer.byteLength(char);
        if (used + bytes > budgetBytes)
            break;
        result += char;
        used += bytes;
    }
    return result;
}
function takeUtf8End(text, budgetBytes) {
    let used = 0;
    let start = text.length;
    let cursor = text.length;
    while (cursor > 0) {
        const end = cursor;
        cursor -= 1;
        if (isLowSurrogate(text.charCodeAt(cursor)) &&
            cursor > 0 &&
            isHighSurrogate(text.charCodeAt(cursor - 1))) {
            cursor -= 1;
        }
        const bytes = Buffer.byteLength(text.slice(cursor, end));
        if (used + bytes > budgetBytes)
            break;
        start = cursor;
        used += bytes;
    }
    return text.slice(start);
}
function isHighSurrogate(codeUnit) {
    return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}
function isLowSurrogate(codeUnit) {
    return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}
function buildExternalizedReceipt(input) {
    const toolName = truncateUtf8(normalizeReceiptText(input.toolName), 64) || 'tool';
    const source = readReceiptSource(input.toolName, input.args);
    const sourceLine = source ? `Source: ${truncateUtf8(source, 256)}\n` : '';
    const errorLine = input.isError ? 'Result: error\n' : '';
    const chunkedInstruction = input.artifact.metadata?.read_format === 'chunked_jsonl_v1'
        ? "\nArtifact format: chunked JSONL; concatenate each chunk row's text field in index order."
        : '';
    return `[Tool output externalized
Tool: ${toolName}
${sourceLine}${errorLine}Artifact: ${input.artifact.reference}${chunkedInstruction}

Recover the needed facts from this artifact now, before answering, inferring, or searching another source.
Search this artifact first with bounded rg/grep when available, then read the relevant ranges with read(path, offset, limit).
If artifact search is unavailable, use bounded read directly.
Do not read or print the entire artifact in a single call.
When complete content is required, continue with bounded reads until all of it has been read.
Do not treat this receipt as evidence.]`;
}
function readReceiptSource(toolName, args) {
    if (!isRecord(args))
        return undefined;
    const canonicalToolName = normalizeReceiptText(toolName).toLowerCase();
    if (canonicalToolName === 'grep') {
        const pattern = readReceiptSourceField(args, 'pattern');
        const path = readReceiptSourceField(args, 'path') ?? readReceiptSourceField(args, 'file_path');
        const source = [pattern, path].filter((field) => Boolean(field)).join('; ');
        if (source)
            return source;
    }
    for (const key of ['query', 'url', 'pattern', 'path', 'file_path']) {
        const source = readReceiptSourceField(args, key);
        if (source)
            return source;
    }
    return undefined;
}
function readReceiptSourceField(args, key) {
    const value = args[key];
    if (typeof value !== 'string')
        return undefined;
    // Source is only a receipt anchor. Bound it before whitespace normalization
    // so a huge tool argument cannot add another full-string scan here.
    const normalized = normalizeReceiptText(takeUtf8Start(value, 512));
    return normalized ? `${key}=${JSON.stringify(normalized)}` : undefined;
}
function normalizeReceiptText(value) {
    return value.replaceAll(/\s+/gu, ' ').trim();
}
function truncateUtf8(value, maxBytes) {
    if (Buffer.byteLength(value) <= maxBytes)
        return value;
    const ellipsis = '…';
    const ellipsisBytes = Buffer.byteLength(ellipsis);
    if (maxBytes <= ellipsisBytes)
        return '';
    return takeUtf8Start(value, maxBytes - ellipsisBytes) + ellipsis;
}
function mergeBudgetDetails(details, budget) {
    const base = isRecord(details)
        ? details
        : details === undefined
            ? {}
            : { original_details: details };
    return { ...base, tool_output_budget: budget };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
async function notifyArtifactError(observer, error, input) {
    if (!observer)
        return;
    try {
        await observer(error, input);
    }
    catch {
        // Observability must not replace the bounded fallback result.
    }
}
//# sourceMappingURL=tool-output-budget.js.map