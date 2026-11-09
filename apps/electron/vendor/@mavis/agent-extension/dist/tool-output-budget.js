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
        if (!canRecoverArtifact(toolContext))
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
/**
 * Whether this exact call may swap text for an artifact reference.
 *
 * A run_code (PTC) child result goes to the program, not to the model context:
 * a reference would hand the script a pointer instead of its data (and its
 * structured data would be dropped as a rewritten result). Pi sets
 * parentToolCallId only on PTC child calls (pi-agent-core AfterToolCallContext);
 * run_code's own outer result is still eligible. A reference is also only safe
 * when this turn has `read` to open the artifact.
 */
function canRecoverArtifact(toolContext) {
    if (toolContext.parentToolCallId)
        return false;
    return toolContext.context.tools?.some((tool) => tool.name === 'read') ?? false;
}
function buildArtifactInput(ctx, toolCallId, toolName, args, text, originalBytes, sensitive, part) {
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
        ...(part ? { part } : {}),
    };
}
/**
 * How to read an artifact the host stored as chunked JSONL (a line longer than
 * the read limit); empty for a plain text artifact.
 */
function artifactFormatInstruction(artifact) {
    return artifact.metadata?.read_format === 'chunked_jsonl_v1'
        ? "Artifact format: chunked JSONL; concatenate each chunk row's text field in index order."
        : '';
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
    const formatInstruction = artifactFormatInstruction(input.artifact);
    return `[Tool output externalized
Tool: ${toolName}
${sourceLine}${errorLine}Artifact: ${input.artifact.reference}${formatInstruction ? `\n${formatInstruction}` : ''}

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
        // Observability must not change the ToolResult returned to History.
    }
}
const WEB_SEARCH_TOOL_NAME = 'web_search';
/** Head plus tail bytes of one page `content` kept in the model-visible result. */
export const WEB_SEARCH_CONTENT_INLINE_BYTES = 4 * 1_024;
/**
 * The web_search rule of the output budget: bounds each page once, before the
 * result enters History and before toolOutputBudgetExtension measures it.
 * Every page `content` is written to its own artifact, and the result names
 * that file in `content_file`; a `content` above the limit keeps its head and
 * tail around a marker. All other fields stay as they were. The result is left
 * alone when canRecoverArtifact says no, when the search failed, and when a
 * write fails.
 */
export function webSearchContentBudgetExtension(options) {
    const maxContentBytes = options.maxContentBytes ?? WEB_SEARCH_CONTENT_INLINE_BYTES;
    if (!Number.isSafeInteger(maxContentBytes) || maxContentBytes <= 0) {
        throw new Error('webSearchContentBudgetExtension: maxContentBytes must be a positive integer');
    }
    const afterToolCall = async (toolContext, _signal, turnCtx) => {
        if (toolContext.toolCall.name !== WEB_SEARCH_TOOL_NAME || toolContext.isError)
            return undefined;
        if (!canRecoverArtifact(toolContext))
            return undefined;
        const content = toolContext.result.content;
        const found = findSearchPayload(content);
        if (!found)
            return undefined;
        const pages = found.payload.results.flatMap((value, index) => isRecord(value) && typeof value.content === 'string' && value.content.length > 0
            ? [{ index, result: value, text: value.content }]
            : []);
        if (pages.length === 0)
            return undefined;
        const inputs = pages.map((page) => buildArtifactInput(turnCtx, toolContext.toolCall.id, WEB_SEARCH_TOOL_NAME, toolContext.args, page.text, Buffer.byteLength(page.text), false, `result-${String(page.index + 1).padStart(2, '0')}`));
        let artifacts;
        try {
            artifacts = await Promise.all(inputs.map((input) => options.writeArtifact(input)));
        }
        catch (error) {
            await notifyArtifactError(options.onArtifactError, error, inputs[0]);
            return undefined;
        }
        const results = [...found.payload.results];
        let truncated = 0;
        pages.forEach((page, position) => {
            const bytes = inputs[position].originalBytes;
            const artifact = artifacts[position];
            let inline = page.text;
            if (bytes > maxContentBytes) {
                const formatInstruction = artifactFormatInstruction(artifact);
                const notice = `\n\n[web_search content truncated: ${bytes} bytes; middle omitted. Full content: content_file${formatInstruction ? `. ${formatInstruction}` : ''}]\n\n`;
                inline = headTailPreview(page.text, maxContentBytes, notice);
                truncated += 1;
            }
            results[page.index] = withContentFile(page.result, inline, artifact.reference);
        });
        const text = JSON.stringify({ ...found.payload, results }, null, 2);
        const details = toolContext.result.details;
        return {
            content: content.map((block, index) => index === found.blockIndex ? { type: 'text', text } : block),
            details: {
                ...(isRecord(details) ? details : {}),
                web_search_content: {
                    pages: pages.length,
                    truncated,
                    max_content_bytes: maxContentBytes,
                },
            },
        };
    };
    return {
        id: 'web-search-content-budget',
        description: 'Write every web_search page content to its own artifact and keep a bounded head/tail inline.',
        init(pi) {
            pi.on('after_tool_call', afterToolCall);
        },
    };
}
function findSearchPayload(content) {
    for (const [blockIndex, block] of content.entries()) {
        if (block.type !== 'text' || typeof block.text !== 'string')
            continue;
        let parsed;
        try {
            parsed = JSON.parse(block.text);
        }
        catch {
            continue;
        }
        if (isRecord(parsed) && Array.isArray(parsed.results)) {
            return { blockIndex, payload: parsed };
        }
    }
    return undefined;
}
/** Same field order as the service's page, with `content_file` right after `content`. */
function withContentFile(result, content, reference) {
    const next = {};
    for (const [key, value] of Object.entries(result)) {
        if (key === 'content_file')
            continue;
        next[key] = key === 'content' ? content : value;
        if (key === 'content')
            next.content_file = reference;
    }
    return next;
}
//# sourceMappingURL=tool-output-budget.js.map