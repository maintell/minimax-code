export const MCP_OAUTH_CIMD_CLIENT_ID = 'https://agent.minimax.io/minimax-code/oauth/mcp-client.json';
/** Stable OAuth failure. Messages never contain tokens, secrets, URLs with query strings or response bodies. */
export class McpOAuthError extends Error {
    code;
    name = 'McpOAuthError';
    constructor(code, options) {
        super(code, options);
        this.code = code;
    }
}
//# sourceMappingURL=contracts.js.map