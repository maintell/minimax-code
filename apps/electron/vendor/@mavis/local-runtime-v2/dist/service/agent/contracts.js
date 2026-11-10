/** `capabilities.selectorVersion` of Task snapshots captured with the current selector rules. */
export const FROZEN_SELECTOR_VERSION = 2;
/**
 * Frozen `mcpServers` of a version 2 snapshot whose Agent wrote `mcpServers: []`
 * (no MCP); there an empty list means unrestricted. See README "Desktop Local Agent 定义".
 */
export const FROZEN_MCP_SERVERS_NONE = ':none';
/**
 * Placeholder kept in frozen `tools` when a compatible Plugin Agent named
 * `mcp__*` tools but alias rebinding left none (its server published no
 * tools, or a name collides): those tools are unavailable. It names no tool
 * (runtime MCP names never contain `:`); it only keeps the list read as a
 * complete list. See README "Desktop Local Agent 定义".
 */
export const FROZEN_TOOLS_ALL_SCOPE_MARKER = 'mcp__:none';
//# sourceMappingURL=contracts.js.map