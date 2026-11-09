import { readModelAccessMetadata } from '../model-access/projection.js';
import { failoverPlan } from './pool-config.js';
function minimum(a, b) {
    return a === undefined || b === undefined ? undefined : Math.min(a, b);
}
function mergeModel(a, b) {
    const context = minimum(a.limit?.context, b.limit?.context);
    const output = minimum(a.limit?.output, b.limit?.output);
    return {
        ...a,
        thinking: {
            ...a.thinking,
            effortOptions: [
                ...new Set([...(a.thinking?.effortOptions ?? []), ...(b.thinking?.effortOptions ?? [])]),
            ],
        },
        modalities: {
            ...a.modalities,
            input: [
                ...new Set([...(a.modalities?.input ?? ['text']), ...(b.modalities?.input ?? ['text'])]),
            ],
        },
        limit: { ...(context ? { context } : {}), ...(output ? { output } : {}) },
    };
}
/** Display union only. Every actual call rechecks one complete member capability matrix. */
export function poolCatalog(deps, key) {
    const tree = deps.config().custom_provider ?? {};
    const root = readModelAccessMetadata(tree[key])?.groupEntryKey ?? key;
    const plan = failoverPlan(deps, root);
    if (!plan?.grouped)
        return tree[key]?.models ?? {};
    const out = memberUnion(tree, root, plan.members);
    const preferences = tree[root]?.options?.modelAccess;
    for (const [id, model] of Object.entries(out))
        if (preferences?.modelEnabled?.[id] === false)
            model.enabled = false;
    const order = Array.isArray(preferences?.modelOrder)
        ? preferences.modelOrder.filter((id) => typeof id === 'string' && Object.hasOwn(out, id))
        : [];
    return orderedCatalog(out, order);
}
/** Every member's models, less those deleted on the group root (another account may list them). */
function memberUnion(tree, root, members) {
    const out = {};
    for (const member of members)
        addModels(out, tree[member.providerKey]?.models);
    for (const id of readModelAccessMetadata(tree[root])?.removedModels ?? [])
        delete out[id];
    return out;
}
function orderedCatalog(out, order) {
    const ordered = {};
    for (const id of [...order, ...Object.keys(out)]) {
        const model = out[id];
        if (model)
            ordered[id] = model;
    }
    return ordered;
}
function addModels(out, models = {}) {
    for (const [id, model] of Object.entries(models)) {
        const old = out[id];
        out[id] = old
            ? { ...mergeModel(old, model), enabled: old.enabled !== false || model.enabled !== false }
            : structuredClone(model);
    }
}
//# sourceMappingURL=pool-catalog.js.map