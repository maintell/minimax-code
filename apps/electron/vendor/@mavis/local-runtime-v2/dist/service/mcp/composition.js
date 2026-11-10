import { initializeMcpService, } from './initialize.js';
import { createMcpRuntimeLogger } from './logging.js';
import { createMcpOAuthService } from './oauth/index.js';
/**
 * MCP owner with OAuth for user, project and plugin servers. OAuth requests
 * leave through the host proxy fetch like MCP traffic; the owner closes the
 * OAuth service last.
 */
export function initializeMcpServiceWithOAuth(options) {
    // Same observability channel as the MCP runtime, including the TUI diagnostics sink.
    const logger = createMcpRuntimeLogger(options.diagnostics, options.logger);
    return initializeMcpService({
        ...options,
        oauth: createMcpOAuthService({
            dataDir: options.dataDir,
            ...(options.nowMs ? { now: options.nowMs } : {}),
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
            ...(logger ? { logger } : {}),
        }),
    });
}
/** Delivery-facing MCP surfaces: settings, runtime and OAuth user actions. */
export function mcpDeliveryServices(mcp) {
    return { mcp: mcp.service, mcpRuntime: mcp.runtime, ...(mcp.auth ? { mcpAuth: mcp.auth } : {}) };
}
/** Plugin discovery borrows the OAuth service and announces session-less requirements. */
export function pluginMcpAuthDependencies(mcp) {
    return {
        ...(mcp.oauth ? { mcpOAuth: mcp.oauth } : {}),
        publishAuthRequired: mcp.announcePluginAuthRequired,
    };
}
//# sourceMappingURL=composition.js.map