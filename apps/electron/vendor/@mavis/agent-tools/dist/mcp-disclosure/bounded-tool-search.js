import { Buffer } from 'node:buffer';
import { Type } from '@sinclair/typebox';
import { defineRuntimeTool } from '@mavis/agent-core/tools';
export function createBoundedToolSearchTool(index, opts) {
    const maxResults = Number.isFinite(opts.topKMax)
        ? Math.max(1, Math.min(20, Math.trunc(opts.topKMax)))
        : 20;
    const defaultResults = Number.isFinite(opts.topKDefault)
        ? Math.max(1, Math.min(maxResults, Math.trunc(opts.topKDefault)))
        : 5;
    const schema = Type.Object({
        query: Type.Optional(Type.String({
            maxLength: 512,
            description: 'Keyword search (BM25, supports Chinese) over tool name/description/params.',
        })),
        regex: Type.Optional(Type.String({
            maxLength: 256,
            description: 'Regex filter over tool name/description/schema text (case-insensitive).',
        })),
        top_k: Type.Optional(Type.Integer({
            minimum: 1,
            maximum: maxResults,
            description: `Max results (default ${defaultResults}, max ${maxResults}).`,
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
        description: 'Discover on-demand tools, including scheduled-task management and configured integrations, that are absent from your default tool list. ' +
            'Search by keyword `query` and/or `regex`; returns the full definitions (name, description, input_schema) of the top matches. ' +
            'Then call `mcp_invoke` with the chosen tool_name and arguments to use one.',
        schema,
        execute: async (_ctx, input) => {
            if (!input.query?.trim() && !input.regex?.trim())
                return err('Provide at least one of `query` or `regex`.');
            if ((input.query?.length ?? 0) > 512 || (input.regex?.length ?? 0) > 256)
                return err('query is limited to 512 characters; regex is limited to 256 characters.');
            if (input.top_k !== undefined &&
                (!Number.isInteger(input.top_k) || input.top_k < 1 || input.top_k > maxResults))
                return err(`top_k must be an integer between 1 and ${maxResults}.`);
            if (input.regex) {
                try {
                    const _validate = new RegExp(input.regex, 'i');
                    void _validate;
                }
                catch (e) {
                    return err(`Invalid regex: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            const topK = Math.max(1, Math.min(maxResults, Math.trunc(input.top_k ?? defaultResults)));
            const matches = index.search({ query: input.query, regex: input.regex, topK });
            const hits = [];
            const budget = opts.maxResultBytes ?? 32 * 1024;
            const serialize = () => JSON.stringify({
                hits,
                total: matches.length,
                returned: hits.length,
                omitted: matches.length - hits.length,
                ...(hits.length < matches.length
                    ? {
                        notice: 'Some complete definitions exceeded the response budget. Narrow the search or lower top_k. A single oversized definition requires a smaller tool contract.',
                    }
                    : {}),
            });
            for (const match of matches) {
                hits.push(match);
                if (Buffer.byteLength(serialize(), 'utf8') > budget) {
                    hits.pop();
                }
            }
            const text = serialize();
            return { tool_name: 'tool_search', text, content: [{ type: 'text', text }] };
        },
    });
}
//# sourceMappingURL=bounded-tool-search.js.map