/**
 * Orders model ids by the models.dev catalog's `last_updated` / `release_date`.
 * Pure: the caller supplies the raw catalog record from a validated snapshot.
 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}/u;
/** Lowercase id with any `vendor/` prefix removed. */
function exactKey(modelId) {
    const value = modelId.trim().toLowerCase();
    const slash = value.lastIndexOf('/');
    return slash >= 0 ? value.slice(slash + 1) : value;
}
/** `gemini-2.5-pro`, `gemini_2_5-pro` and `Gemini 2.5 Pro` share one key. */
function normalizedKey(modelId) {
    return exactKey(modelId)
        .normalize('NFKC')
        .replace(/[\s._-]+/gu, '');
}
function dateValue(value) {
    return typeof value === 'string' && DATE_PATTERN.test(value) ? value.slice(0, 10) : undefined;
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function push(map, key, entry) {
    if (!key)
        return;
    const list = map.get(key);
    if (list)
        list.push(entry);
    else
        map.set(key, [entry]);
}
export function buildModelRecencyIndex(catalog) {
    const exact = new Map();
    const normalized = new Map();
    for (const [providerId, provider] of Object.entries(catalog)) {
        if (!isRecord(provider) || !isRecord(provider.models))
            continue;
        for (const [modelId, model] of Object.entries(provider.models)) {
            if (!isRecord(model))
                continue;
            const lastUpdated = dateValue(model.last_updated);
            const releaseDate = dateValue(model.release_date);
            if (!lastUpdated && !releaseDate)
                continue;
            const entry = {
                providerId,
                ...(lastUpdated ? { lastUpdated } : {}),
                ...(releaseDate ? { releaseDate } : {}),
            };
            push(exact, exactKey(modelId), entry);
            push(normalized, normalizedKey(modelId), entry);
        }
    }
    return { exact, normalized };
}
/** Positive when `left` is more recent; missing dates are oldest. */
function compareRecency(left, right) {
    const updated = (left?.lastUpdated ?? '').localeCompare(right?.lastUpdated ?? '');
    if (updated !== 0)
        return updated;
    return (left?.releaseDate ?? '').localeCompare(right?.releaseDate ?? '');
}
function newest(entries) {
    let best;
    for (const entry of entries)
        if (compareRecency(entry, best) > 0)
            best = entry;
    return best;
}
/** @internal Exported for focused tests. */
export function lookupModelRecency(index, modelId, preferredProviders = []) {
    const preferred = new Set(preferredProviders);
    for (const [map, key] of [
        [index.exact, exactKey(modelId)],
        [index.normalized, normalizedKey(modelId)],
    ]) {
        const entries = map.get(key);
        if (!entries?.length)
            continue;
        const own = preferred.size ? entries.filter((entry) => preferred.has(entry.providerId)) : [];
        const match = newest(own.length ? own : entries);
        if (match) {
            return {
                ...(match.lastUpdated ? { lastUpdated: match.lastUpdated } : {}),
                ...(match.releaseDate ? { releaseDate: match.releaseDate } : {}),
            };
        }
    }
    // Cursor/Grok expose context-window choices as separate ids, with the base model's date.
    const baseId = modelId.replace(/@\d+(?:[km])?$/iu, '');
    if (baseId !== modelId)
        return lookupModelRecency(index, baseId, preferredProviders);
    return undefined;
}
/**
 * Newest first by `last_updated`, then `release_date`; ties and unknown models
 * keep their source order, unknown models last. Duplicate ids keep the first.
 */
export function rankModelIdsByRecency(index, input) {
    const seen = new Set();
    const rows = input.modelIds.flatMap((modelId, position) => {
        if (seen.has(modelId))
            return [];
        seen.add(modelId);
        return [
            { modelId, position, recency: lookupModelRecency(index, modelId, input.preferredProviders) },
        ];
    });
    return rows
        .sort((left, right) => {
        if (left.recency && !right.recency)
            return -1;
        if (!left.recency && right.recency)
            return 1;
        return compareRecency(right.recency, left.recency) || left.position - right.position;
    })
        .map((row) => row.modelId);
}
//# sourceMappingURL=model-recency.js.map