export function renderMcpToolSearchHintBlock() {
    return [
        '<system-reminder>',
        'Use `tool_search` to discover permitted on-demand tools for scheduled tasks, session management, and MCP integrations.',
        'Search with a keyword `query` and/or `regex`, read the returned parameter definitions, then call',
        '`mcp_invoke` with the exact `tool_name` and `arguments`. Availability follows the current Agent.',
        'Keep using direct tools when they cover the task; search results supply the definitions of additional tools.',
        '</system-reminder>',
    ].join('\n');
}
//# sourceMappingURL=hint.js.map