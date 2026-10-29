import { buildOrReuseIndex } from './search-index.js';
export function modelInWhitelist(provider, id, list) {
    const key = `${provider}/${id}`;
    return list.some((pat) => {
        if (pat === '*' || pat === key)
            return true;
        if (!pat.includes('*'))
            return false;
        const re = new RegExp(`^${pat
            .split('*')
            .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('.*')}$`);
        return re.test(key);
    });
}
function defaultEstimate(def) {
    return Math.ceil(JSON.stringify({ name: def.name, description: def.description, schema: def.schema }).length / 4);
}
export function planMcpDisclosure(input) {
    const { entries, model, options } = input;
    const names = new Set();
    for (const { tool } of entries) {
        if (names.has(tool.def.name))
            throw new Error(`Duplicate on-demand tool: ${tool.def.name}`);
        names.add(tool.def.name);
    }
    const explicitlyDeferred = (tool) => tool.def.loading === 'on_demand' ||
        (tool.def.loading !== 'default' && input.retainedDeferredTools?.has(tool) === true);
    const candidates = entries.filter(({ tool, source }) => source === 'configured' && tool.def.loading !== 'default' && !explicitlyDeferred(tool));
    const estimate = options?.estimateTokens ?? defaultEstimate;
    const validContext = model !== undefined && Number.isFinite(model.contextWindow) && model.contextWindow > 0;
    const thresholdTokens = options && validContext ? options.thresholdPct * model.contextWindow : 0;
    const automaticallyDefer = Boolean(options?.enabled &&
        model &&
        validContext &&
        modelInWhitelist(model.provider, model.id, options.modelWhitelist) &&
        candidates.length >= options.minDeferCount &&
        candidates.reduce((sum, { tool }) => sum + estimate(tool.def), 0) > thresholdTokens);
    const deferredEntries = entries.filter(({ tool, source }) => explicitlyDeferred(tool) ||
        (automaticallyDefer && source === 'configured' && tool.def.loading !== 'default'));
    if (deferredEntries.length === 0) {
        return { deferred: false, inlineTools: entries.map(({ tool }) => tool) };
    }
    const deferredRegistry = new Map(deferredEntries.map(({ tool }) => [tool.def.name, tool]));
    const inlineTools = entries
        .filter(({ tool }) => !deferredRegistry.has(tool.def.name))
        .map(({ tool }) => tool);
    const index = buildOrReuseIndex(deferredEntries, {
        maxSchemaTextLen: options?.maxSchemaTextLen ?? 4096,
    });
    return {
        deferred: true,
        inlineTools,
        deferredRegistry,
        index,
        stats: {
            candidateCount: deferredEntries.length,
            indexedCount: index.size,
            estTokens: deferredEntries.reduce((sum, { tool }) => sum + estimate(tool.def), 0),
            thresholdTokens,
        },
    };
}
//# sourceMappingURL=plan.js.map