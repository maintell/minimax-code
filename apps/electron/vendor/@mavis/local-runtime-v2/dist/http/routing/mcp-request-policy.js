import { AppError } from '../errors.js';
import { CALL_LOCAL_MCP_RUNTIME_TOOL, CREATE_LOCAL_MCP_SERVER, UPDATE_LOCAL_MCP_SERVER, UPSERT_LOCAL_MCP_RUNTIME_SERVER, } from './contracts.gen.js';
import { withRequestParseErrorMapper } from './define-route.js';
const MCP_CONFIG_MUTATION_ROUTES = new Set([
    CREATE_LOCAL_MCP_SERVER.name,
    UPDATE_LOCAL_MCP_SERVER.name,
    UPSERT_LOCAL_MCP_RUNTIME_SERVER.name,
]);
/** Apply MCP-specific wire parsing semantics at the MCP binding declaration boundary. */
export function withMcpRequestParseErrorPolicy(bindings) {
    return bindings.map((binding) => {
        if (MCP_CONFIG_MUTATION_ROUTES.has(binding.name)) {
            return withRequestParseErrorMapper(binding, () => new AppError(400, 'MCP_CONFIG_INVALID', 'MCP configuration is invalid'));
        }
        if (binding.name === CALL_LOCAL_MCP_RUNTIME_TOOL.name) {
            return withRequestParseErrorMapper(binding, () => new AppError(400, 'MCP_CALL_INVALID', 'MCP call request is invalid'));
        }
        return binding;
    });
}
//# sourceMappingURL=mcp-request-policy.js.map