import { createHash } from 'node:crypto';
export function computeHistoryDigest(value) {
    return createHash('sha256').update(stableJson(value)).digest('hex');
}
function stableJson(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(',')}]`;
    const record = value;
    return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
        .join(',')}}`;
}
//# sourceMappingURL=history-digest.js.map