import { Type } from '@sinclair/typebox';
import { defineRuntimeTool } from '@mavis/agent-core/tools';
export function createToolSearchTool(index, opts) {
    const schema = Type.Object({
        query: Type.Optional(Type.String({
            description: 'Keyword search (BM25, supports Chinese) over tool name/description/params.',
        })),
        regex: Type.Optional(Type.String({
            description: 'Regex filter over tool name/description/schema text (case-insensitive).',
        })),
        top_k: Type.Optional(Type.Number({
            description: `Max results (default ${opts.topKDefault}, max ${opts.topKMax}).`,
        })),
    });
    const err = (text) => ({
        tool_name: 'tool_search',
        text,
        content: [{ type: 'text', text }],
        isError: true,
    });
    return defineRuntimeTool({
        name: 'tool_search',
        description: 'Discover additional integration tools provided by configured MCP servers that are NOT listed in your tools. ' +
            'Search by keyword `query` and/or `regex`; returns the full definitions (name, description, input_schema) of the top matches. ' +
            'Then call `mcp_invoke` with the chosen tool_name and arguments to use one.',
        schema,
        execute: async (_ctx, input) => {
            if (!input.query?.trim() && !input.regex?.trim())
                return err('Provide at least one of `query` or `regex`.');
            if (input.regex) {
                try {
                    const _validate = new RegExp(input.regex, 'i');
                    void _validate;
                }
                catch (e) {
                    return err(`Invalid regex: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            const topK = Math.max(1, Math.min(opts.topKMax, Math.trunc(input.top_k ?? opts.topKDefault)));
            const hits = index.search({ query: input.query, regex: input.regex, topK });
            const text = JSON.stringify({ hits, total: hits.length });
            return { tool_name: 'tool_search', text, content: [{ type: 'text', text }] };
        },
    });
}
//# sourceMappingURL=tool-search.js.map