import { McpToolCallNotDispatchedError, McpToolCallTimeoutError } from '@mavis/mcp';
const UNAVAILABLE_SERVER_DIAGNOSTICS = new Set([
    'MCP_SERVER_LIST_FAILED',
    'MCP_SERVER_WARMING',
]);
/**
 * Serves `context.tool` every published Plugin MCP tool under its runtime name, as an Agent turn
 * sees it. Calls run the snapshot's runtime tool, so they reach the MCP runtime generation that
 * listed the tool; that generation is leased for the call like a turn's, so a publication cannot
 * close it mid-call.
 */
export function createMiniAppPluginMcpTools(host) {
    return {
        async list() {
            const snapshot = host.currentSnapshot;
            const tools = pluginMcpBindings(snapshot).flatMap((binding) => listedTool(binding));
            const partial = snapshot.diagnostics.some((diagnostic) => UNAVAILABLE_SERVER_DIAGNOSTICS.has(diagnostic.code) &&
                snapshot.mcpServers.some((entry) => entry.pluginName === diagnostic.pluginName &&
                    entry.server.name === diagnostic.capabilityName));
            return { tools, partial };
        },
        async call(input) {
            const snapshot = host.currentSnapshot;
            const view = snapshot.turnCapabilities;
            const binding = pluginMcpBindings(snapshot).find((candidate) => candidate.tool.def.name === input.name);
            if (!binding)
                return refusal('TOOL_REF_STALE');
            try {
                host.retainTurnCapabilities(view);
            }
            catch {
                return refusal('MCP_SERVER_UNAVAILABLE');
            }
            try {
                const result = await binding.tool.impl.execute({ sessionId: `miniapp:${input.pluginId}`, turnId: 'miniapp-tool-call' }, input.arguments, input.signal);
                return projectMcpResult(result.details?.mcp);
            }
            catch (error) {
                // The pool's only error that proves nothing reached the server.
                if (error instanceof McpToolCallNotDispatchedError)
                    return refusal('REQUEST_CANCELLED');
                return error instanceof McpToolCallTimeoutError ? serverTimeout() : unknownOutcome();
            }
            finally {
                host.releaseTurnCapabilities(view);
            }
        },
    };
}
function pluginMcpBindings(snapshot) {
    return snapshot.turnCapabilities.runtimeToolBindings.filter((binding) => binding.kind === 'mcp' && typeof binding.mcpToolName === 'string');
}
function listedTool(binding) {
    if (!binding.mcpToolName)
        return [];
    const { def } = binding.tool;
    return [
        {
            name: def.name,
            server: binding.source,
            tool: binding.mcpToolName,
            ...(def.description ? { description: def.description } : {}),
            inputSchema: { ...def.schema },
        },
    ];
}
function projectMcpResult(value) {
    if (!isRecord(value) || !Array.isArray(value.content))
        return unknownOutcome();
    return {
        ok: true,
        isError: value.isError === true,
        content: value.content,
        ...(isRecord(value.structuredContent) ? { structuredContent: value.structuredContent } : {}),
    };
}
function refusal(code) {
    return { ok: false, code, disposition: 'not_dispatched' };
}
/** The server outlived its own timeout after dispatch: it may have run. */
function serverTimeout() {
    return { ok: false, code: 'TOOL_TIMEOUT', disposition: 'unknown_after_dispatch' };
}
function unknownOutcome() {
    return { ok: false, code: 'TOOL_OUTCOME_UNKNOWN', disposition: 'unknown_after_dispatch' };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=miniapp-plugin-mcp-tools.js.map