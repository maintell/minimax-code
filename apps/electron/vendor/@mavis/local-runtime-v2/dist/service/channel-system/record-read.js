/**
 * Neutral raw-record readers shared across the channel-system service.
 *
 * Migration copy (MR1): v1 channel code imported `readFirstString` from the
 * v1 HTTP helper module `api/http-helpers.ts`. The reader itself is pure data
 * access over an already-parsed record, so the v2 copy lives inside the
 * service and the HTTP-only helpers (json/notFound/readJsonBody) stay with
 * the delivery layer that owns Request/Response parsing.
 *
 * Semantics are kept byte-compatible with the v1 helper: the value must be a
 * non-empty string, and it is returned WITHOUT trimming. Several codecs rely
 * on this exact behaviour when re-reading persisted YAML fields.
 */
export function readFirstString(data, keys) {
    for (const key of keys) {
        const value = data[key];
        if (typeof value === 'string' && value.length > 0)
            return value;
    }
    return undefined;
}
//# sourceMappingURL=record-read.js.map