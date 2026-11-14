import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { publishFileIfAbsent, replaceFileAtomically } from '../../../infra/file/jsonl.js';
/** Rebuilding a request never applies more deltas than this. */
const MAX_REQUEST_DELTA_DEPTH = 64;
/** Equal-block comparison runs in native code; only the differing block is scanned bytewise. */
const COMPARE_BLOCK_BYTES = 64 * 1024;
export function payloadPath(payloadDirectory, callId, file) {
    const extension = file === 'request-delta' ? 'request.delta' : `${file}.json`;
    return join(payloadDirectory, `${Buffer.from(callId, 'utf8').toString('base64url')}.${extension}`);
}
/** Stored requests of one Session, in capture order, plus the newest one as the next base. */
export class RequestChainIndex {
    refs = new Map();
    latest;
    record(callId, ref) {
        const depth = ref.delta
            ? (this.refs.get(ref.delta.baseCallId)?.depth ?? MAX_REQUEST_DELTA_DEPTH) + 1
            : 0;
        this.refs.set(callId, { ...ref, depth });
        this.latest = { callId, depth };
    }
    lookup(callId) {
        return this.refs.get(callId);
    }
    /** The base for the next delta, or undefined when the next request must be a keyframe. */
    nextBase() {
        if (!this.latest || this.latest.depth >= MAX_REQUEST_DELTA_DEPTH)
            return undefined;
        return this.latest.callId;
    }
}
/**
 * Store one request as a delta against the newest stored request when that saves
 * at least half of its bytes, and as a full keyframe otherwise.
 */
export async function publishRequestPayload(input) {
    const current = Buffer.from(input.json, 'utf8');
    const delta = await deltaAgainstNewest(input.payloadDirectory, input.index, current);
    if (delta) {
        // A crash may have left this Call's delta against another base; the event is
        // not written yet, so replacing it is safe and keeps the bytes in step with it.
        await replaceFileAtomically(payloadPath(input.payloadDirectory, input.callId, 'request-delta'), delta.inserted);
        return delta.ref;
    }
    await publishFileIfAbsent(payloadPath(input.payloadDirectory, input.callId, 'request'), current);
    return undefined;
}
async function deltaAgainstNewest(payloadDirectory, index, current) {
    const baseCallId = index.nextBase();
    if (baseCallId === undefined)
        return undefined;
    const base = await new RequestChainReader(payloadDirectory, (callId) => index.lookup(callId)).read(baseCallId);
    if (!base)
        return undefined;
    const splice = spliceBetween(base, current);
    if (splice.inserted.length * 2 > current.length)
        return undefined;
    return {
        ref: { baseCallId, prefixBytes: splice.prefixBytes, suffixBytes: splice.suffixBytes },
        inserted: splice.inserted,
    };
}
function spliceBetween(base, current) {
    const shared = Math.min(base.length, current.length);
    const prefixBytes = commonPrefixBytes(base, current, shared);
    const suffixBytes = commonSuffixBytes(base, current, shared - prefixBytes);
    return {
        prefixBytes,
        suffixBytes,
        inserted: current.subarray(prefixBytes, current.length - suffixBytes),
    };
}
function commonPrefixBytes(left, right, limit) {
    let matched = 0;
    while (matched < limit) {
        const end = Math.min(matched + COMPARE_BLOCK_BYTES, limit);
        if (!left.subarray(matched, end).equals(right.subarray(matched, end)))
            break;
        matched = end;
    }
    while (matched < limit && left[matched] === right[matched])
        matched += 1;
    return matched;
}
function commonSuffixBytes(left, right, limit) {
    let matched = 0;
    while (matched < limit) {
        const size = Math.min(COMPARE_BLOCK_BYTES, limit - matched);
        const leftEnd = left.length - matched;
        const rightEnd = right.length - matched;
        if (!left.subarray(leftEnd - size, leftEnd).equals(right.subarray(rightEnd - size, rightEnd))) {
            break;
        }
        matched += size;
    }
    while (matched < limit && left[left.length - 1 - matched] === right[right.length - 1 - matched]) {
        matched += 1;
    }
    return matched;
}
/**
 * Rebuild stored requests of one Session. A missing file, an over-long chain or a
 * length mismatch yields undefined, never a guessed body.
 *
 * Reading requests in capture order is O(1) per request: each delta's base is the
 * request rebuilt just before it, which the reader keeps until the next read.
 */
export class RequestChainReader {
    payloadDirectory;
    lookup;
    recent;
    constructor(payloadDirectory, lookup) {
        this.payloadDirectory = payloadDirectory;
        this.lookup = lookup;
    }
    async read(callId) {
        const chain = this.chainTo(callId);
        if (!chain)
            return undefined;
        let bytes = chain.start === this.recent?.callId
            ? this.recent.bytes
            : await this.readKeyframe(chain.start);
        for (const link of chain.links) {
            if (!bytes)
                return undefined;
            bytes = await this.applyLink(bytes, link);
        }
        if (bytes)
            this.recent = { callId, bytes };
        return bytes;
    }
    /** Deltas from the nearest rebuilt or full request up to callId, oldest first. */
    chainTo(callId) {
        const links = [];
        let cursor = callId;
        for (let step = 0; step <= MAX_REQUEST_DELTA_DEPTH; step += 1) {
            const ref = this.lookup(cursor);
            if (!ref)
                return undefined;
            if (cursor === this.recent?.callId || !ref.delta) {
                return { start: cursor, links: links.reverse() };
            }
            links.push({ callId: cursor, delta: ref.delta, byteLength: ref.byteLength });
            cursor = ref.delta.baseCallId;
        }
        return undefined;
    }
    async readKeyframe(callId) {
        const bytes = await readOptional(payloadPath(this.payloadDirectory, callId, 'request'));
        return bytes && matchesLength(bytes, this.lookup(callId)?.byteLength) ? bytes : undefined;
    }
    async applyLink(base, link) {
        const inserted = await readOptional(payloadPath(this.payloadDirectory, link.callId, 'request-delta'));
        const { prefixBytes, suffixBytes } = link.delta;
        if (!inserted || prefixBytes + suffixBytes > base.length)
            return undefined;
        const bytes = Buffer.concat([
            base.subarray(0, prefixBytes),
            inserted,
            base.subarray(base.length - suffixBytes),
        ]);
        return matchesLength(bytes, link.byteLength) ? bytes : undefined;
    }
}
function matchesLength(bytes, byteLength) {
    return byteLength === undefined || bytes.length === byteLength;
}
async function readOptional(path) {
    try {
        return await readFile(path);
    }
    catch {
        return undefined;
    }
}
export function decodeRequestDelta(value) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'object' ||
        value === null ||
        !isNonEmptyString(Reflect.get(value, 'baseCallId')) ||
        !isByteCount(Reflect.get(value, 'prefixBytes')) ||
        !isByteCount(Reflect.get(value, 'suffixBytes'))) {
        throw new Error('invalid request delta');
    }
    return {
        baseCallId: Reflect.get(value, 'baseCallId'),
        prefixBytes: Reflect.get(value, 'prefixBytes'),
        suffixBytes: Reflect.get(value, 'suffixBytes'),
    };
}
function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
}
function isByteCount(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
//# sourceMappingURL=request-payload-chain.js.map