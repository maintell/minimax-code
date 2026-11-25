const SPACE_UPLOAD_TOOL_NAME = 'space_upload';
const MCP_INVOKE_TOOL_NAME = 'mcp_invoke';
/**
 * Records the local file -> Space file mapping of every `space_upload` the Agent ran (directly or
 * through `mcp_invoke`), so the Working folder can show its cloud sync state. Failures are logged
 * only.
 */
export function createAssetsUploadSyncRecorder(options) {
    return async (input, signal) => {
        if (!isSpaceUploadCall(input.toolContext))
            return;
        const uploads = parseAssetsUploadOutputs(readResultText(input.toolContext.result.content));
        for (const upload of uploads) {
            if (signal.aborted)
                return;
            try {
                await options.record({ sessionId: input.sessionId, ...upload });
                log(options.logger, 'info', input, { outcome: 'recorded' });
            }
            catch (error) {
                log(options.logger, 'warn', input, { outcome: 'failed', reason: safeErrorReason(error) });
            }
        }
    };
}
/**
 * @internal Exported only for focused parser tests; production goes through the recorder.
 *
 * Finds the `space_upload` result objects in the ToolResult text. Only objects that start a line
 * are tried, and only ones with `node.node_id`, `source_path` and `sha256` count, so a failure
 * result (or a truncated object) is ignored.
 */
export function parseAssetsUploadOutputs(text) {
    if (!text.includes('"source_path"') || !text.includes('"sha256"'))
        return [];
    const uploads = [];
    let from = 0;
    while (from < text.length) {
        const start = nextLineStartBrace(text, from);
        if (start < 0)
            break;
        const end = matchingBrace(text, start);
        if (end < 0) {
            from = start + 1;
            continue;
        }
        const upload = readUploadOutput(text.slice(start, end + 1));
        if (upload)
            uploads.push(upload);
        from = upload ? end + 1 : start + 1;
    }
    return uploads;
}
function isSpaceUploadCall(toolContext) {
    const name = toolContext.toolCall.name;
    if (name === SPACE_UPLOAD_TOOL_NAME)
        return true;
    return (name === MCP_INVOKE_TOOL_NAME && readRecord(toolContext.args)?.tool_name === SPACE_UPLOAD_TOOL_NAME);
}
function nextLineStartBrace(text, from) {
    for (let index = text.indexOf('{', from); index >= 0; index = text.indexOf('{', index + 1)) {
        if (index === 0 || text[index - 1] === '\n')
            return index;
    }
    return -1;
}
/** Index of the `}` closing the object at `start`, honoring JSON strings; -1 when unbalanced. */
function matchingBrace(text, start) {
    let depth = 0;
    let inString = false;
    for (let index = start; index < text.length; index += 1) {
        const char = text[index];
        if (inString) {
            if (char === '\\')
                index += 1;
            else if (char === '"')
                inString = false;
            continue;
        }
        if (char === '"')
            inString = true;
        else if (char === '{')
            depth += 1;
        else if (char === '}') {
            depth -= 1;
            if (depth === 0)
                return index;
        }
    }
    return -1;
}
function readUploadOutput(candidate) {
    let value;
    try {
        value = JSON.parse(candidate);
    }
    catch {
        return undefined;
    }
    const output = readRecord(value);
    const node = readRecord(output?.node);
    const nodeId = readString(node?.node_id);
    const path = readString(output?.source_path);
    const sha256 = readString(output?.sha256);
    if (!nodeId || !path || !sha256)
        return undefined;
    const drivePath = readString(node?.path);
    return { path, nodeId, sha256, ...(drivePath ? { drivePath } : {}) };
}
function readResultText(content) {
    return content
        .map((part) => readRecord(part))
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part?.text)
        .join('\n');
}
function log(logger, level, input, decision) {
    try {
        logger?.[level]?.({
            event: 'assets_upload_sync_record',
            session_id: input.sessionId,
            turn_id: input.turnId,
            tool_call_id: input.toolContext.toolCall.id,
            outcome: decision.outcome,
            ...(decision.reason ? { reason: decision.reason } : {}),
        }, '[local-runtime-v2] assets upload sync record');
    }
    catch {
        // Diagnostics must never affect the ToolResult.
    }
}
function safeErrorReason(error) {
    const record = readRecord(error);
    if (typeof record?.reason === 'string' && record.reason.trim())
        return record.reason.trim();
    if (typeof record?.code === 'string' && record.code.trim())
        return record.code.trim();
    return error instanceof Error && error.name.trim() ? error.name.trim() : 'unknown_error';
}
function readString(value) {
    return typeof value === 'string' && value.trim() ? value : undefined;
}
function readRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
//# sourceMappingURL=assets-upload-sync-recorder.js.map