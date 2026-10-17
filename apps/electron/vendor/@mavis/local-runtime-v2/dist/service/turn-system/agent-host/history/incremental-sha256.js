import { createHash } from 'node:crypto';
const UTF8_CHUNK_CODE_UNITS = 8 * 1_024;
/** Native SHA-256 with bounded batching and independent UTF-8 update boundaries. */
export class IncrementalSha256 {
    hash = createHash('sha256');
    finalized = false;
    pending = '';
    update(value) {
        if (this.finalized)
            throw new Error('SHA-256 digest is already finalized.');
        let offset = 0;
        while (offset < value.length) {
            const end = safeUtf8ChunkEnd(value, offset);
            let chunk = value.slice(offset, end);
            // Each update encodes separately. A trailing high surrogate must not pair
            // with a low surrogate supplied by a later update when we batch strings.
            if (isHighSurrogate(chunk.charCodeAt(chunk.length - 1))) {
                chunk = `${chunk.slice(0, -1)}\ufffd`;
            }
            if (this.pending.length + chunk.length > UTF8_CHUNK_CODE_UNITS)
                this.flush();
            this.pending += chunk;
            if (this.pending.length === UTF8_CHUNK_CODE_UNITS)
                this.flush();
            offset = end;
        }
    }
    digestHex() {
        if (this.finalized)
            throw new Error('SHA-256 digest is already finalized.');
        this.flush();
        this.finalized = true;
        return this.hash.digest('hex');
    }
    flush() {
        if (this.pending.length === 0)
            return;
        this.hash.update(this.pending, 'utf8');
        this.pending = '';
    }
}
function safeUtf8ChunkEnd(value, offset) {
    let end = Math.min(value.length, offset + UTF8_CHUNK_CODE_UNITS);
    const last = value.charCodeAt(end - 1);
    const next = value.charCodeAt(end);
    if (end < value.length && isHighSurrogate(last) && isLowSurrogate(next))
        end -= 1;
    return end;
}
function isHighSurrogate(value) {
    return value >= 0xd800 && value <= 0xdbff;
}
function isLowSurrogate(value) {
    return value >= 0xdc00 && value <= 0xdfff;
}
//# sourceMappingURL=incremental-sha256.js.map