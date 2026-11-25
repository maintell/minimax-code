import { createHash } from 'node:crypto';
export function computeContinuationHistoryDigest(manifest) {
    const logicalHistory = {
        schema: manifest.schema,
        sanitizer_version: manifest.sanitizer_version,
        assets: manifest.assets,
        messages: manifest.messages,
    };
    return createHash('sha256').update(stableJson(logicalHistory)).digest('hex');
}
function stableJson(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value)) {
        const items = [];
        for (const item of value)
            items.push(stableJson(item));
        return `[${items.join(',')}]`;
    }
    const record = value;
    const fields = [];
    const keys = Object.keys(record).sort();
    for (const key of keys)
        fields.push(`${JSON.stringify(key)}:${stableJson(record[key])}`);
    return `{${fields.join(',')}}`;
}
//# sourceMappingURL=continuation-history-digest.js.map