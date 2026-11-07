import { McpToolCallNotDispatchedError } from '@mavis/mcp';
import { configToTransportConfig, readConfiguredTools, readRecord } from '../runtime/config.js';
import { normalizeCallResult } from './result-mapping.js';
/** The call never left the Host, for a reason the caller can act on. */
export class LocalMcpCallRefusedError extends Error {
    code;
    name = 'LocalMcpCallRefusedError';
    constructor(code, message, options) {
        super(message, options);
        this.code = code;
    }
}
/**
 * The Mini App tool port's call: the same server, tool, and mock resolution as
 * `LocalMcpService.call`, without folding failures into an error result. A refusal before
 * dispatch throws `LocalMcpCallRefusedError`; whatever the pool throws (not dispatched, server
 * timeout, a dropped connection, a cancel in flight) reaches the caller as it is and does not mark
 * the server failed. A result the tool itself marked `isError` resolves unchanged.
 */
export async function callLocalMcpToolUnfolded(service, input, live) {
    const { server, toolName, args, signal } = input;
    const config = await listedServerConfig(service, input);
    const mocked = readRecord(readRecord(config.metadata?.['mockResponses'])?.[toolName]);
    if (mocked)
        return normalizeCallResult(mocked);
    const { pool } = live;
    if (!pool || !configToTransportConfig(config)) {
        throw new LocalMcpCallRefusedError('MCP_SERVER_UNAVAILABLE', `MCP server "${server}" has no usable connection`);
    }
    const overrides = await connectionOverrides(live, config, server);
    if (signal.aborted)
        throw new McpToolCallNotDispatchedError(server, toolName);
    const result = await pool.callTool(server, toolName, args, overrides, {
        ...(config.timeout && config.timeout > 0 ? { timeout: config.timeout } : {}),
        signal: live.signal(config),
    });
    live.recorded(config);
    return result;
}
/** The enabled server's config, once it is known to list the tool. */
async function listedServerConfig(service, { server, toolName }) {
    const config = await service.getServerConfig(server);
    if (!config || config.enabled === false) {
        throw new LocalMcpCallRefusedError('MCP_SERVER_UNAVAILABLE', `MCP server "${server}" is off`);
    }
    const lists = (tools) => tools.some((tool) => tool.name === toolName);
    if (!lists(readConfiguredTools(config)) && !lists(await service.listToolsLive(server))) {
        throw new LocalMcpCallRefusedError('TOOL_REF_STALE', `MCP tool "${toolName}" is not listed`);
    }
    return config;
}
async function connectionOverrides(live, config, server) {
    try {
        return await live.overrides(config);
    }
    catch (error) {
        throw new LocalMcpCallRefusedError('MCP_SERVER_UNAVAILABLE', `MCP server "${server}" credentials are unavailable`, { cause: error });
    }
}
//# sourceMappingURL=miniapp-call.js.map