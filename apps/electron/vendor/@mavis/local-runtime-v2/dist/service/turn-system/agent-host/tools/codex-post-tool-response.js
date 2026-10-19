import { pluginMcpResponse, } from './vendor-post-tool-response.js';
/**
 * Codex exposes the model-facing FunctionCallOutput body unless the tool owns
 * a more stable response. Desktop can reproduce that contract exactly for a
 * single text block, and Plugin MCP owns the original CallToolResult.
 */
export function buildCodexPostToolResponse(input) {
    const mcpResponse = pluginMcpResponse(input);
    if (mcpResponse)
        return mcpResponse;
    const content = input.result.content;
    if (!content?.length)
        return undefined;
    const text = [];
    for (const part of content) {
        if (part.type !== 'text')
            return undefined;
        text.push(part.text);
    }
    return text.join('\n');
}
//# sourceMappingURL=codex-post-tool-response.js.map