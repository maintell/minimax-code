import { buildOrReuseIndex, createMcpInvokeTool, createToolSearchTool, } from '@mavis/agent-tools';
export function mergeDesktopTurnTools(input) {
    const capabilities = input.capabilities;
    if (!capabilities)
        return { tools: input.tools, plan: input.plan };
    // toolMode 放在 binding 上，用工具对象本身关联，避免仅凭名称把状态套到其他来源的同名工具。
    const bindingByTool = new Map(capabilities.runtimeToolBindings.map((binding) => [binding.tool, binding]));
    // 原生工具和已经进入搜索索引的 MCP 工具优先；Desktop 同名工具不能覆盖它们。
    const usedNames = new Set(input.tools.map((tool) => normalizedToolName(tool.def.name)));
    if (input.plan.deferred) {
        for (const name of input.plan.deferredRegistry.keys())
            usedNames.add(normalizedToolName(name));
    }
    const inlineTools = [];
    const searchableTools = [];
    for (const tool of capabilities.runtimeTools) {
        const binding = bindingByTool.get(tool);
        // Plugin MCP 等没有 Connector 状态的 Desktop 工具沿用原来的 inline 行为。
        const mode = binding?.kind === 'app' ? normalizeDesktopToolMode(binding.toolMode) : 'inline';
        // omit 在最终工具清单入口直接丢弃，后面的 inline 列表和搜索索引都不会再看到它。
        if (mode === 'omit')
            continue;
        const name = normalizedToolName(tool.def.name);
        if (!name || usedNames.has(name))
            continue;
        usedNames.add(name);
        if (mode === 'tool_search')
            searchableTools.push(tool);
        else
            inlineTools.push(tool);
    }
    // 没有强制进入搜索的 Connector 工具时，不额外创建 tool_search / mcp_invoke。
    if (searchableTools.length === 0) {
        return { tools: [...input.tools, ...inlineTools], plan: input.plan };
    }
    const deferredRegistry = new Map(input.plan.deferred ? input.plan.deferredRegistry : []);
    // 如果 MCP 已经启用按需搜索，就把 Connector 工具合并到同一个索引，避免出现两组同名入口。
    for (const tool of searchableTools)
        deferredRegistry.set(tool.def.name, tool);
    const deferredEntries = [...deferredRegistry.values()].map((tool) => ({
        tool,
        source: 'configured',
    }));
    const index = buildOrReuseIndex(deferredEntries, {
        maxSchemaTextLen: input.options.maxSchemaTextLen,
    });
    const estimate = input.options.estimateTokens ?? estimateToolTokens;
    const forcedEstimate = searchableTools.reduce((total, tool) => total + estimate(tool.def), 0);
    const plan = {
        deferred: true,
        inlineTools: input.plan.inlineTools,
        deferredRegistry,
        index,
        stats: {
            candidateCount: (input.plan.deferred ? input.plan.stats.candidateCount : 0) + searchableTools.length,
            indexedCount: index.size,
            estTokens: (input.plan.deferred ? input.plan.stats.estTokens : 0) + forcedEstimate,
            thresholdTokens: input.plan.deferred
                ? input.plan.stats.thresholdTokens
                : input.options.thresholdPct * input.model.contextWindow,
        },
    };
    // 通用搜索入口绑定的是拆分前的索引；先移除再按合并后的索引重建。
    const baseTools = input.plan.deferred
        ? input.tools.filter((tool) => tool.def.name !== 'tool_search' && tool.def.name !== 'mcp_invoke')
        : input.tools;
    return {
        tools: [
            ...baseTools,
            createToolSearchTool(index, {
                topKDefault: input.options.topKDefault,
                topKMax: input.options.topKMax,
            }),
            createMcpInvokeTool(deferredRegistry),
            ...inlineTools,
        ],
        plan,
    };
}
function normalizeDesktopToolMode(value) {
    // 缺省值和无法识别的值不能改变既有 inline 行为。
    if (value === 'omit' || value === 'tool_search')
        return value;
    return 'inline';
}
function estimateToolTokens(def) {
    return Math.ceil(JSON.stringify({
        name: def.name,
        description: def.description,
        schema: def.schema,
    }).length / 4);
}
function normalizedToolName(name) {
    return name.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
//# sourceMappingURL=local-desktop-tool-modes.js.map