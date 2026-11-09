/**
 * MCP request authorization contract.
 *
 * The host (local-runtime-v2 OAuth service) implements `McpRequestAuthorizer`; the transport's
 * authorized fetch layer calls it to inject Bearer tokens and to classify 401/403 challenges.
 * This module only defines protocol-level types — storage and product state live in the host.
 */
const MCP_AUTH_REQUIRED_ERROR_NAME = 'McpAuthRequiredError';
export class McpAuthRequiredError extends Error {
    reason;
    challenge;
    name = MCP_AUTH_REQUIRED_ERROR_NAME;
    constructor(reason, challenge, options) {
        super(`MCP server requires authorization (${reason})`, options);
        this.reason = reason;
        this.challenge = challenge;
    }
}
/**
 * Walks the cause chain, matching by `name` so errors created by another module instance
 * (SDK / zod dual installs, bundled copies) are still recognised.
 */
export function findMcpAuthRequiredError(error) {
    const seen = new Set();
    let current = error;
    while (current instanceof Error && !seen.has(current)) {
        if (current.name === MCP_AUTH_REQUIRED_ERROR_NAME && 'reason' in current) {
            return current;
        }
        seen.add(current);
        current = current.cause;
    }
    return undefined;
}
//# sourceMappingURL=auth.js.map