import { getModel } from '@earendil-works/pi-ai';
import { isMiniMaxM3, MINIMAX_M3_STANDARD_COST } from './minimax-m3-cost.js';
/**
 * Per-model `contextWindow` / `maxTokens` used when the pi-ai catalog does
 * not list the requested `(provider, modelId)` pair. Keep this floor aligned
 * with the M2.7-level defaults in `~/.minimax/config.yaml`: a conservative
 * 200k physical window with enough per-call output budget for agent turns.
 */
const FALLBACK_MODEL_LIMITS = {
    contextWindow: 200_000,
    maxTokens: 128_000,
};
const ZERO_MODEL_COST = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
};
// pi-ai's `getModel` is typed against the static `KnownProvider` / model
// union but, per its runtime implementation, returns `undefined` for any
// unknown pair. Widen it so an arbitrary user-supplied ModelRef can flow
// through without a narrowing burden at every call site.
const lookupCatalogModel = getModel;
/**
 * Look up `(provider, modelId)` in pi-ai's generated model catalog and
 * return its real `contextWindow` / `maxTokens`. Falls back to
 * {@link FALLBACK_MODEL_LIMITS} when the pair is absent so unknown model
 * ids still produce a usable (if conservative) shape; callers should warn
 * once when the fallback fires. Callers trim the ids.
 */
export function resolveModelLimits(provider, modelId) {
    const entry = lookupCatalogModel(provider, modelId);
    if (!entry)
        return { ...FALLBACK_MODEL_LIMITS, fromCatalog: false };
    const contextWindow = typeof entry.contextWindow === 'number' && entry.contextWindow > 0
        ? entry.contextWindow
        : FALLBACK_MODEL_LIMITS.contextWindow;
    const maxTokens = typeof entry.maxTokens === 'number' && entry.maxTokens > 0
        ? entry.maxTokens
        : FALLBACK_MODEL_LIMITS.maxTokens;
    return { contextWindow, maxTokens, fromCatalog: true };
}
/**
 * The `Model.cost` a cloud run reports: MiniMax-M3 uses its standard-tier
 * rates (the long-context tier is a per-usage decision), any other catalog
 * model uses its list price, and an unknown model costs zero. Always a
 * fresh object.
 */
export function resolveCloudModelCost(provider, modelId) {
    if (isMiniMaxM3(provider, modelId))
        return cloneModelCost(MINIMAX_M3_STANDARD_COST);
    return cloneModelCost(resolveCatalogModelCost(provider, modelId) ?? ZERO_MODEL_COST);
}
/**
 * The catalog list price for `(provider, modelId)` (ids are trimmed), or
 * undefined when the pair is absent or any rate is not a finite
 * non-negative number.
 */
export function resolveCatalogModelCost(provider, modelId) {
    const cost = lookupCatalogModel(provider.trim(), modelId.trim())?.cost;
    if (!cost)
        return undefined;
    const input = finiteNonNegative(cost.input);
    const output = finiteNonNegative(cost.output);
    const cacheRead = finiteNonNegative(cost.cacheRead);
    const cacheWrite = finiteNonNegative(cost.cacheWrite);
    if (input === undefined ||
        output === undefined ||
        cacheRead === undefined ||
        cacheWrite === undefined) {
        return undefined;
    }
    return { input, output, cacheRead, cacheWrite };
}
function finiteNonNegative(value) {
    if (typeof value === 'number') {
        return Number.isFinite(value) && value >= 0 ? value : undefined;
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
    }
    return undefined;
}
function cloneModelCost(cost) {
    return {
        input: cost.input,
        output: cost.output,
        cacheRead: cost.cacheRead,
        cacheWrite: cost.cacheWrite,
    };
}
//# sourceMappingURL=model-catalog.js.map