import { createMiniAppLocalMcpTools } from '../../service/mcp/index.js';
import { createMiniAppToolPermissions, } from '../../service/miniapp/index.js';
import { describeError } from './turn-message-delivery.js';
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