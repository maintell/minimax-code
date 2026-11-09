/** The target cannot be resolved to a remote MCP server in its source. */
export class McpAuthTargetError extends Error {
    name = 'McpAuthTargetError';
    code = 'MCP_OAUTH_TARGET_NOT_FOUND';
    status = 404;
    constructor() {
        super('MCP authorization target was not found.');
    }
}
//# sourceMappingURL=ports.js.map