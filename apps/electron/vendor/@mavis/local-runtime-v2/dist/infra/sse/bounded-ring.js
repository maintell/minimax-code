import { randomUUID } from 'node:crypto';
const DEFAULT_MAX_ITEMS = 512;
const DEFAULT_MAX_BYTES = 2 * 1_024 * 1_024;
export class BoundedRing {
    evictionPolicy;
    entries = [];
    identities = new Map();
    maxItems;
    maxBytes;
    measure;
    cursorPrefix;
    nextCursor = 1n;
    droppedThrough = 0n;
    retainedBytes = 0;
    constructor(options = {}, evictionPolicy) {
        this.evictionPolicy = evictionPolicy;
        this.maxItems = positiveInteger(options.maxItems, DEFAULT_MAX_ITEMS);
        this.maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
        this.measure = options.measure ?? measureValue;
        this.cursorPrefix = createCursorPrefix(options.cursorScope, options.cursorEpoch);
    }
    append(input) {
        const duplicate = this.identities.get(input.identity);
        if (duplicate) {
            return { ...duplicate, appended: false, retained: true, evictedCount: 0 };
        }
        const entry = {
            cursor: this.formatCursor(this.nextCursor),
            identity: input.identity,
            value: input.value,
            byteSize: normalizedByteSize(input.byteSize ?? this.measure(input.value)),
        };
        this.nextCursor += 1n;
        this.entries.push(entry);
        this.identities.set(entry.identity, entry);
        this.retainedBytes += entry.byteSize;
        const evictedCount = this.enforceRetention();
        const retained = this.identities.has(entry.identity);
        return {
            ...entry,
            appended: true,
            retained,
            evictedCount: retained ? evictedCount : Math.max(0, evictedCount - 1),
        };
    }
    replay(afterCursor) {
        if (afterCursor === undefined || afterCursor.length === 0) {
            return { status: 'ok', entries: [...this.entries] };
        }
        const parsed = this.parseCursor(afterCursor);
        if (parsed === undefined || parsed >= this.nextCursor) {
            return { status: 'invalid-cursor', entries: [] };
        }
        if (parsed < this.droppedThrough)
            return { status: 'evicted', entries: [] };
        return {
            status: 'ok',
            entries: this.entries.filter((entry) => {
                const sequence = this.parseCursor(entry.cursor);
                return sequence !== undefined && sequence > parsed;
            }),
        };
    }
    latestCursor() {
        return this.formatCursor(this.nextCursor - 1n);
    }
    isAfter(cursor, watermark) {
        if (!cursor)
            return false;
        const selected = this.parseCursor(cursor);
        const boundary = this.parseCursor(watermark);
        return selected !== undefined && boundary !== undefined && selected > boundary;
    }
    enforceRetention() {
        let evictedCount = 0;
        while (this.entries.length > 0) {
            const selected = normalizedEvictionCount(this.evictionPolicy?.({
                entries: [...this.entries],
                retainedBytes: this.retainedBytes,
                maxItems: this.maxItems,
                maxBytes: this.maxBytes,
            }), this.entries.length);
            const overBounds = this.entries.length > this.maxItems || this.retainedBytes > this.maxBytes;
            let count = selected;
            if (count === 0 && overBounds)
                count = 1;
            if (count === 0)
                break;
            evictedCount += this.evictPrefix(count);
        }
        return evictedCount;
    }
    evictPrefix(count) {
        return Array.from({ length: count }).reduce((evictedCount) => {
            const evicted = this.entries.shift();
            if (!evicted)
                return evictedCount;
            this.identities.delete(evicted.identity);
            this.retainedBytes -= evicted.byteSize;
            const sequence = this.parseCursor(evicted.cursor);
            if (sequence !== undefined)
                this.droppedThrough = sequence;
            return evictedCount + 1;
        }, 0);
    }
    formatCursor(sequence) {
        return `${this.cursorPrefix}${sequence}`;
    }
    parseCursor(value) {
        if (!value.startsWith(this.cursorPrefix))
            return undefined;
        const sequence = value.slice(this.cursorPrefix.length);
        if (!/^\d+$/.test(sequence))
            return undefined;
        try {
            return BigInt(sequence);
        }
        catch {
            return undefined;
        }
    }
}
export function measureValue(value) {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    return new TextEncoder().encode(serialized ?? 'undefined').byteLength;
}
function positiveInteger(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : fallback;
}
function normalizedByteSize(value) {
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}
function normalizedEvictionCount(value, retainedCount) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
        return 0;
    return Math.min(Math.floor(value), retainedCount);
}
function createCursorPrefix(scope, epoch) {
    return `sse1:${encodeURIComponent(scope ?? 'ring')}:${encodeURIComponent(epoch ?? randomUUID())}:`;
}
//# sourceMappingURL=bounded-ring.js.map