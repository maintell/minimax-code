import { createDeferredLocalAgentRuntimePort } from '../../service/agent/index.js';
import { createDeferredLocalSandboxBashOperationsFactory } from '../../service/sandbox/index.js';
import { createMiniAppLocalMcpTools } from '../../service/mcp/index.js';
import { createMiniAppToolPermissions, } from '../../service/miniapp/index.js';
import { describeError } from './turn-message-delivery.js';
/** Creates the deferred service ports required before the host binds its consumers. */
export function createRuntimeServicePorts(options) {
    return {
        agentRuntimePort: createDeferredLocalAgentRuntimePort(),
        sandboxOperationsFactory: createDeferredLocalSandboxBashOperationsFactory(options.sandboxEnabled, options.bashEnvPolicy, options.getSkipParentDeathGuard),
    };
}
export function planFailureReporter(product, stage) {
    return (error) => {
        product.executor.reportFailure?.('plan-lifecycle', `owner=plan;stage=${stage};error=${describeError(error)}`);
    };
}
/** What `context.tool` reaches beyond Plugin MCP; each port is optional on non-desktop hosts. */
export function miniAppToolHostPorts(compatibility, mcpRuntime) {
    const requestApproval = compatibility.miniAppSurface?.requestToolApproval;
    return {
        localMcp: createMiniAppLocalMcpTools(mcpRuntime),
        ...(compatibility.miniAppToolRules
            ? { permissions: createMiniAppToolPermissions(compatibility.miniAppToolRules) }
            : {}),
        ...(requestApproval ? { approvals: { request: (request) => requestApproval(request) } } : {}),
    };
}
//# sourceMappingURL=runtime-service-ports.js.map