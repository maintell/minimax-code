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
    const allTools = entries.map((e) => e.tool);
    const inlineAll = () => ({ deferred: false, inlineTools: allTools });
    if (!options.enabled)
        return inlineAll();
    if (!modelInWhitelist(model.provider, model.id, options.modelWhitelist))
        return inlineAll();
    // The threshold (thresholdPct * contextWindow) is meaningless without a real
    // context window. A non-positive/non-finite contextWindow would make
    // thresholdTokens collapse to 0, deferring on any single tool. This guard also
    // keeps the empty-identity NO_DISCLOSURE_MODEL sentinel inline regardless of the
    // whitelist (including the '*' wildcard).
    if (!(Number.isFinite(model.contextWindow) && model.contextWindow > 0))
        return inlineAll();
    const candidates = entries.filter((e) => e.source === 'configured');
    const estimate = options.estimateTokens ?? defaultEstimate;
    const estTokens = candidates.reduce((s, e) => s + estimate(e.tool.def), 0);
    const thresholdTokens = options.thresholdPct * model.contextWindow;
    if (candidates.length < options.minDeferCount || estTokens <= thresholdTokens)
        return inlineAll();
    const inlineTools = entries.filter((e) => e.source !== 'configured').map((e) => e.tool);
    const index = buildOrReuseIndex(candidates, { maxSchemaTextLen: options.maxSchemaTextLen });
    const deferredRegistry = new Map(candidates.map((e) => [e.tool.def.name, e.tool]));
    return {
        deferred: true,
        inlineTools,
        deferredRegistry,
        index,
        stats: {
            candidateCount: candidates.length,
            indexedCount: index.size,
            estTokens,
            thresholdTokens,
        },
    };
}
//# sourceMappingURL=plan.js.map