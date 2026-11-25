import { createPluginMcpCallSource, } from './plugin-mcp-call-source.js';
const UNAVAILABLE_SERVER_DIAGNOSTICS = new Set([
    'MCP_SERVER_LIST_FAILED',
    'MCP_SERVER_WARMING',
    'MCP_SERVER_AUTH_REQUIRED',
]);
/**
 * Serves `context.tool` every published Plugin MCP tool under its runtime name, as an Agent turn
 * sees it: a name projection over the Plugin MCP call source, which leases the listing generation
 * for the call like a turn's, so a publication cannot close it mid-call.
 */
export function createMiniAppPluginMcpTools(host, calls = createPluginMcpCallSource(host)) {
    const published = () => calls
        .list()
        .flatMap((target) => [...target.tools].map(([tool, entry]) => ({ target, tool, entry })));
    return {
        async list() {
            const snapshot = host.currentSnapshot;
            const tools = published().map(({ target, tool, entry: { runtimeName, ...definition } }) => ({
                name: runtimeName,
                server: target.server,
                tool,
                ...definition,
            }));
            const partial = snapshot.diagnostics.some((diagnostic) => UNAVAILABLE_SERVER_DIAGNOSTICS.has(diagnostic.code) &&
                snapshot.mcpServers.some((entry) => entry.pluginName === diagnostic.pluginName &&
                    entry.server.name === diagnostic.capabilityName));
            return { tools, partial };
        },
        async call(input) {
            const match = published().find((candidate) => candidate.entry.runtimeName === input.name);
            if (!match)
                return refusal('TOOL_REF_STALE');
            const { target, tool } = match;
            try {
                calls.retain(target.revision);
            }
            catch {
                return refusal('MCP_SERVER_UNAVAILABLE');
            }
            try {
                return projectDispatch(await calls.call({
                    target,
                    tool,
                    args: input.arguments,
                    signal: input.signal,
                    invocation: { sessionId: `miniapp:${input.pluginId}`, turnId: 'miniapp-tool-call' },
                }));
            }
            finally {
                calls.release(target.revision);
            }
        },
    };
}
function projectDispatch(dispatch) {
    if (dispatch.status === 'not_dispatched') {
        return refusal(dispatch.reason === 'cancelled' ? 'REQUEST_CANCELLED' : 'TOOL_REF_STALE');
    }
    if (dispatch.status === 'unknown_after_dispatch') {
        return dispatch.reason === 'timeout' ? serverTimeout() : unknownOutcome();
    }
    const { result } = dispatch;
    return {
        ok: true,
        isError: result.isError === true,
        content: result.content,
        ...(isRecord(result.structuredContent) ? { structuredContent: result.structuredContent } : {}),
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