import { McpToolCallNotDispatchedError, McpToolCallTimeoutError } from '@mavis/mcp';
import { LocalMcpCallRefusedError } from './miniapp-call.js';
/**
 * `context.tool` view of the user `mcp.json` servers and the Host built-in servers: the same
 * global (session-free) inventory and runtime names an Agent turn gets, with the per-turn
 * discovery bounds. Calls skip the Agent path's error folding: a call that provably never reached
 * the server is reported as such, and every other failure is an outcome unknown after dispatch.
 */
export function createMiniAppLocalMcpTools(service) {
    let byName = new Map();
    const refresh = async () => {
        const native = await service.listNativeToolsForTurn();
        byName = new Map(native.map((tool) => [tool.nativeName, tool]));
        return native;
    };
    return {
        async list() {
            const native = await refresh();
            const statuses = await service.listPublicServerStatuses();
            return {
                tools: native.map(listedTool),
                partial: statuses.some((status) => status.status === 'error'),
            };
        },
        async call(input) {
            const tool = byName.get(input.name) ?? (await refresh()).find((t) => t.nativeName === input.name);
            if (!tool)
                return refusal('TOOL_REF_STALE');
            if (input.signal.aborted)
                return refusal('REQUEST_CANCELLED');
            try {
                const result = await service.callForMiniApp({
                    server: tool.server,
                    toolName: tool.toolName,
                    args: { ...input.arguments },
                    signal: input.signal,
                });
                return {
                    ok: true,
                    isError: result.isError === true,
                    content: Array.isArray(result.content) ? result.content : [],
                    ...(isRecord(result.structuredContent)
                        ? { structuredContent: result.structuredContent }
                        : {}),
                };
            }
            catch (error) {
                return callFailure(error, input.signal);
            }
        },
    };
}
/** Anything but a refusal or a pool abort before sending happened after dispatch. */
function callFailure(error, signal) {
    if (error instanceof LocalMcpCallRefusedError)
        return refusal(error.code);
    if (error instanceof McpToolCallNotDispatchedError)
        return refusal('REQUEST_CANCELLED');
    // A server timeout happened after dispatch; so did a cancel the pool could not stop in time.
    if (error instanceof McpToolCallTimeoutError)
        return unknownAfterDispatch('TOOL_TIMEOUT');
    if (signal.aborted)
        return unknownAfterDispatch('REQUEST_CANCELLED');
    return unknownAfterDispatch('TOOL_OUTCOME_UNKNOWN');
}
function unknownAfterDispatch(code) {
    return { ok: false, code, disposition: 'unknown_after_dispatch' };
}
function listedTool(tool) {
    return {
        name: tool.nativeName,
        server: tool.server,
        tool: tool.toolName,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema,
        ...(tool.source === 'configured' ? {} : { builtin: true }),
    };
}
function refusal(code) {
    return { ok: false, code, disposition: 'not_dispatched' };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=miniapp-tools.js.map