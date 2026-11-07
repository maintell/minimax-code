import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-history-json-value.js';
/** Stable semantic revision: SHA-256 over the JSON array of recursively key-sorted records. */
export function computeRevision(records) {
    return revisionDigest(extendRevisionHash(undefined, records, records.length).hash);
}
/**
 * Hashes records [state.count, to) on a copy of `state`, so a history that only grew hashes
 * just its new records. The result matches hashing every record from scratch byte for byte.
 */
export function extendRevisionHash(state, records, to) {
    const hash = state ? state.hash.copy() : createHash('sha256').update('[');
    for (let index = state?.count ?? 0; index < to; index += 1) {
        if (index > 0)
            hash.update(',');
        hash.update(canonicalJson(records[index]), 'utf8');
    }
    return { count: to, hash };
}
export function revisionDigest(hash) {
    return `sha256:${hash.copy().update(']').digest('hex')}`;
}
//# sourceMappingURL=canonical-history-revision.js.map