/** Request header carrying the per-process loopback credential. Its value is Host-private. */
export { MINIAPP_LOOPBACK_TOKEN_HEADER, hasMiniAppHostCapability, isMiniAppAgentAccess, } from '@mavis/shared/miniapp-surface';
export const MAX_RUNNING_MINIAPP_SERVICES = 3;
/** Host-reserved path answered by the child guard; the whole `/__mavis/` prefix is reserved. */
export const MINIAPP_LOOPBACK_HEALTH_PATH = '/__mavis/health';
/** `request()` asks for at most this many tools at once. */
export const MINIAPP_TOOL_REQUEST_MAX_NAMES = 10;
/** The only text a Mini App sees for a tool error; Host detail stays in Host logs. */
export const MINIAPP_TOOL_ERROR_MESSAGES = {
    INVALID_ARGUMENTS: 'Mini App tool name or arguments are invalid; list tools again',
    TOOL_NOT_PERMITTED: 'Mini App tool call is not permitted',
    TOOL_APPROVAL_REQUIRED: 'Mini App tool call needs user approval and nobody can approve it now',
    TOOL_UNAVAILABLE: 'Mini App tools are unavailable for this generation',
    TOOL_TIMEOUT: 'Mini App tool request timed out',
    TOOL_REF_STALE: 'Mini App tool is no longer available; list tools again',
    TOOL_RESULT_TOO_LARGE: 'Mini App tool result exceeds the response frame limit',
    TOOL_OUTCOME_UNKNOWN: 'Mini App tool outcome is unknown after dispatch',
    MCP_SERVER_UNAVAILABLE: 'MCP server is unavailable',
    REQUEST_CANCELLED: 'Mini App tool request was cancelled',
};
/**
 * Tool-level refusal or outcome. Connector failures keep their `ConnectorGatewayError`; the wire
 * layer maps both to the Host Connector error shape.
 */
export class MiniAppToolError extends Error {
    code;
    disposition;
    retryable;
    name = 'MiniAppToolError';
    constructor(code, disposition = 'not_dispatched', retryable = false) {
        super(MINIAPP_TOOL_ERROR_MESSAGES[code]);
        this.code = code;
        this.disposition = disposition;
        this.retryable = retryable;
    }
}
/** The permission switch a Mini App's tool calls need, in the permission panel's id form. */
export const MINIAPP_TOOL_CALL_PERMISSION = 'tool:call';
//# sourceMappingURL=contracts.js.map