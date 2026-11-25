import { TOOL_RESULT_COMPACTION_DEFAULTS } from '@mavis/config';
import { McpToolResultHistoryExternalizer, } from '../execution/mcp-tool-result-history-externalizer.js';
/** MCP History externalizer whose fallback threshold is the product default. */
export function createMcpToolResultHistoryExternalizer(options) {
    return new McpToolResultHistoryExternalizer({
        maxInlineBytes: TOOL_RESULT_COMPACTION_DEFAULTS.mcpDetailsMaxInlineKiB * 1_024,
        ...options,
    });
}
//# sourceMappingURL=mcp-tool-result-externalizer.js.map