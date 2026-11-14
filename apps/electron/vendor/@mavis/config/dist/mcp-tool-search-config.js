const BOOLEAN_KEYS = [
    'enabled',
    'systemHint',
    'catalog',
    'exactSelect',
    'directCall',
    'carryAcrossCompaction',
];
const NUMBER_KEYS = [
    'thresholdPct',
    'minDeferCount',
    'topKDefault',
    'topKMax',
    'maxSchemaTextLen',
    'deferBudgetTokens',
    'catalogBudgetTokens',
];
export function parseMcpToolSearchConfig(raw) {
    const obj = raw.mcpToolSearch;
    if (obj == null || typeof obj !== 'object' || Array.isArray(obj))
        return undefined;
    const result = {};
    // Values may arrive as YAML strings ("true", "24000") when written through
    // `config.mcpToolSearch.*` overrides, so accept both native and string forms.
    for (const key of BOOLEAN_KEYS) {
        const value = Reflect.get(obj, key);
        if (typeof value === 'boolean')
            result[key] = value;
        else if (value === 'true' || value === 'false')
            result[key] = value === 'true';
    }
    for (const key of NUMBER_KEYS) {
        const value = Reflect.get(obj, key);
        const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
        if (typeof parsed === 'number' && Number.isFinite(parsed))
            result[key] = parsed;
    }
    const modelWhitelist = Reflect.get(obj, 'modelWhitelist');
    if (Array.isArray(modelWhitelist)) {
        result.modelWhitelist = modelWhitelist.filter((v) => typeof v === 'string');
    }
    return Object.keys(result).length > 0 ? result : undefined;
}
//# sourceMappingURL=mcp-tool-search-config.js.map