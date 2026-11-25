import { IncrementalSha256 } from '../../../agent-host/history/incremental-sha256.js';
/**
 * Stable semantic revision: SHA-256 over the JSON array of recursively
 * key-sorted records. Archive revisions in generation markers use it.
 */
export function semanticHistoryRevision(records) {
    const hash = new IncrementalSha256();
    hash.update('[');
    records.forEach((record, index) => {
        if (index > 0)
            hash.update(',');
        hash.update(canonicalJson(record));
    });
    hash.update(']');
    return `sha256:${hash.digestHex()}`;
}
export function sha256Base64Url(value) {
    const hash = new IncrementalSha256();
    hash.update(value);
    return hash.digestBase64Url();
}
/** The record without its generation marker; only the canonical envelope fields remain. */
export function withoutHistoryArtifact(record) {
    return {
        message_id: record.message_id,
        turn_id: record.turn_id,
        message: record.message,
        ...(record.turn_config ? { turn_config: record.turn_config } : {}),
    };
}
export function sameJson(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
function canonicalJson(value) {
    const serialized = JSON.stringify(sortJsonValue(value));
    if (serialized === undefined) {
        throw new Error('Invalid canonical history envelope: value is not JSON serializable');
    }
    return serialized;
}
function sortJsonValue(value) {
    if (Array.isArray(value))
        return Array.from(value, sortJsonValue);
    if (!isPlainRecord(value))
        return value;
    return Object.fromEntries(Object.keys(value)
        .sort()
        .map((key) => [key, sortJsonValue(value[key])]));
}
function isPlainRecord(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
//# sourceMappingURL=canonical-record.js.map