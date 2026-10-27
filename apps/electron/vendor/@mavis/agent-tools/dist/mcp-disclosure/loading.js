import { createMcpInvokeTool, getMcpInvokeRegistries } from './mcp-invoke.js';
import { buildOrReuseIndex } from './search-index.js';
import { createBoundedToolSearchTool } from './bounded-tool-search.js';
import { planMcpDisclosure } from './plan.js';
/** Plans the final inventory after the host's capability and permission filters. */
export function buildToolLoadingCatalog(input) {
    const { tools } = input;
    const gateways = tools.filter((tool) => tool.def.name === 'mcp_invoke');
    if (gateways.length > 1)
        throw new Error('Duplicate on-demand tool: mcp_invoke');
    const existingInvoke = gateways[0];
    const existing = existingInvoke ? getMcpInvokeRegistries(existingInvoke) : undefined;
    if (existingInvoke && !existing) {
        throw new Error('Cannot merge on-demand tools into an unmanaged mcp_invoke tool.');
    }
    const searches = tools.filter((tool) => tool.def.name === 'tool_search');
    if (searches.length > 1 || (searches.length > 0 && !existing)) {
        throw new Error('Duplicate or unmanaged on-demand tool: tool_search');
    }
    const inventory = [
        ...tools.filter((tool) => tool.def.name !== 'tool_search' && tool.def.name !== 'mcp_invoke'),
        ...(existing?.registry.values() ?? []),
    ];
    for (const tool of inventory) {
        if (tool.def.name === 'tool_search' || tool.def.name === 'mcp_invoke') {
            throw new Error(`Reserved on-demand tool name: ${tool.def.name}`);
        }
    }
    const provenance = new Map(input.entries?.map((entry) => [entry.tool, entry]));
    const plan = planMcpDisclosure({
        entries: inventory.map((tool) => provenance.get(tool) ?? { tool, source: tool.source ?? 'builtin' }),
        model: input.model,
        options: input.options,
        retainedDeferredTools: new Set(existing?.registry.values()),
    });
    if (!plan.deferred && !input.alwaysExpose && !existing) {
        return { tools: [...plan.inlineTools], plan };
    }
    const registry = plan.deferred ? plan.deferredRegistry : new Map();
    const index = plan.deferred
        ? plan.index
        : buildOrReuseIndex([], { maxSchemaTextLen: input.options?.maxSchemaTextLen ?? 4096 });
    const invoke = createMcpInvokeTool(registry, existing?.referenceRegistry);
    return {
        tools: [
            ...plan.inlineTools,
            createBoundedToolSearchTool(index, {
                topKDefault: input.options?.topKDefault ?? 5,
                topKMax: input.options?.topKMax ?? 20,
            }),
            {
                ...invoke,
                ...(existingInvoke?.toolCallProvenanceResolver
                    ? { toolCallProvenanceResolver: existingInvoke.toolCallProvenanceResolver }
                    : {}),
            },
        ],
        plan,
    };
}
/** Preserves the legacy pure-MCP search contract for callers without a new loading policy. */
export function applyToolLoading(tools, options) {
    if (!options && !tools.some((tool) => tool.def.loading === 'on_demand'))
        return [...tools];
    return buildToolLoadingCatalog({ ...options, tools }).tools;
}
//# sourceMappingURL=loading.js.map