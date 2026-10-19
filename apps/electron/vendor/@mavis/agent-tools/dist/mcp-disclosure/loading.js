import { createMcpInvokeTool, getMcpInvokeRegistries } from './mcp-invoke.js';
import { buildOrReuseIndex } from './search-index.js';
import { createBoundedToolSearchTool } from './bounded-tool-search.js';
/** Applies built-in loading declarations after the host's capability and permission filters. */
export function applyToolLoading(tools) {
    const deferred = tools.filter(isDeferredBuiltin);
    if (deferred.length === 0)
        return [...tools];
    const existingInvoke = tools.find((tool) => tool.def.name === 'mcp_invoke');
    const existing = existingInvoke ? getMcpInvokeRegistries(existingInvoke) : undefined;
    if (existingInvoke && !existing) {
        throw new Error('Cannot merge on-demand tools into an unmanaged mcp_invoke tool.');
    }
    const registry = new Map(existing?.registry);
    const visibleNames = new Set(tools.filter((tool) => !isDeferredBuiltin(tool)).map((tool) => tool.def.name));
    for (const tool of deferred) {
        if (registry.has(tool.def.name) || visibleNames.has(tool.def.name)) {
            throw new Error(`Duplicate on-demand tool: ${tool.def.name}`);
        }
        registry.set(tool.def.name, tool);
    }
    const index = buildOrReuseIndex([...registry.values()].map((tool) => ({ tool, source: tool.source ?? 'builtin' })), { maxSchemaTextLen: 4096 });
    const invoke = createMcpInvokeTool(registry, existing?.referenceRegistry);
    return [
        ...tools.filter((tool) => !isDeferredBuiltin(tool) &&
            tool.def.name !== 'tool_search' &&
            tool.def.name !== 'mcp_invoke'),
        createBoundedToolSearchTool(index, { topKDefault: 5, topKMax: 20 }),
        {
            ...invoke,
            ...(existingInvoke?.toolCallProvenanceResolver
                ? { toolCallProvenanceResolver: existingInvoke.toolCallProvenanceResolver }
                : {}),
        },
    ];
}
function isDeferredBuiltin(tool) {
    return (tool.def.loading === 'on_demand' && (tool.source === undefined || tool.source === 'builtin'));
}
//# sourceMappingURL=loading.js.map