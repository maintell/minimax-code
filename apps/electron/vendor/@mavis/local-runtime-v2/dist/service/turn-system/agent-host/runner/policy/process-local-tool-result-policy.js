export function applyProcessLocalToolResultPolicy(tools, enabled) {
    if (!enabled)
        return tools;
    return tools.map((tool) => tool.source === 'builtin-matrix' ? wrapBuiltinMatrixTool(tool) : tool);
}
function wrapBuiltinMatrixTool(tool) {
    return {
        ...tool,
        impl: {
            execute: async (context, input, signal, onUpdate) => markMatrixBusinessFailure(await tool.impl.execute(context, input, signal, onUpdate)),
        },
    };
}
function markMatrixBusinessFailure(result) {
    return isMatrixBusinessFailure(result) ? { ...result, isError: true } : result;
}
function isMatrixBusinessFailure(result) {
    if (readRecord(result.details)?.['ok'] === false)
        return true;
    const mcp = readRecord(readRecord(result.details)?.['mcp']);
    const meta = readRecord(mcp?.['_meta']);
    return readRecord(meta?.['details'])?.['ok'] === false;
}
function readRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
//# sourceMappingURL=process-local-tool-result-policy.js.map