import { measureValue } from './bounded-ring.js';
class SubscriberOverflowError extends Error {
    droppedItems;
    droppedBytes;
    name = 'SubscriberOverflowError';
    constructor(droppedItems, droppedBytes) {
        super(`SSE subscriber overflow: ${droppedItems} items / ${droppedBytes} bytes`);
        this.droppedItems = droppedItems;
        this.droppedBytes = droppedBytes;
    }
}
const DEFAULT_MAX_ITEMS = 128;
const DEFAULT_MAX_BYTES = 512 * 1_024;
export class StreamSubscription {
    registry;
    id;
    queue = [];
    pending;
    filter;
    queuedBytes = 0;
    terminalError;
    closed = false;
    completed = false;
    maxItems;
    maxBytes;
    constructor(registry, id, limits) {
        this.registry = registry;
        this.id = id;
        this.maxItems = limits.maxItems;
        this.maxBytes = limits.maxBytes;
        this.filter = limits.filter;
    }
    [Symbol.asyncIterator]() {
        return this;
    }
    next() {
        if (this.terminalError) {
            const error = this.terminalError;
            this.terminalError = undefined;
            return Promise.reject(error);
        }
        const queued = this.queue.shift();
        if (queued) {
            this.queuedBytes -= queued.byteSize;
            return Promise.resolve({ done: false, value: queued.value });
        }
        if (this.closed || this.completed)
            return Promise.resolve({ done: true, value: undefined });
        if (this.pending)
            return Promise.reject(new Error('Concurrent subscription reads are invalid'));
        return new Promise((resolve, reject) => {
            this.pending = { resolve, reject };
        });
    }
    return() {
        this.close();
        return Promise.resolve({ done: true, value: undefined });
    }
    setFilter(filter) {
        if (this.closed || this.completed)
            return;
        this.filter = filter;
        const retained = this.queue.filter(({ value }) => filter(value));
        this.queue.length = 0;
        this.queue.push(...retained);
        this.queuedBytes = retained.reduce((total, entry) => total + entry.byteSize, 0);
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.queue.length = 0;
        this.queuedBytes = 0;
        this.registry.remove(this.id);
        this.pending?.resolve({ done: true, value: undefined });
        this.pending = undefined;
    }
    complete() {
        if (this.closed || this.completed)
            return;
        this.completed = true;
        this.registry.remove(this.id);
        this.pending?.resolve({ done: true, value: undefined });
        this.pending = undefined;
    }
    push(value, byteSize) {
        if (this.closed || this.completed || (this.filter && !this.filter(value)))
            return;
        if (this.pending) {
            this.pending.resolve({ done: false, value });
            this.pending = undefined;
            return;
        }
        if (this.queue.length + 1 > this.maxItems || this.queuedBytes + byteSize > this.maxBytes) {
            this.overflow(byteSize);
            return;
        }
        this.queue.push({ value, byteSize });
        this.queuedBytes += byteSize;
    }
    overflow(incomingBytes) {
        const droppedItems = this.queue.length + 1;
        const droppedBytes = this.queuedBytes + incomingBytes;
        this.terminalError = new SubscriberOverflowError(droppedItems, droppedBytes);
        this.closed = true;
        this.queue.length = 0;
        this.queuedBytes = 0;
        this.registry.remove(this.id);
        if (this.pending) {
            this.pending.reject(this.terminalError);
            this.terminalError = undefined;
            this.pending = undefined;
        }
    }
}
export class SubscriberRegistry {
    subscribers = new Map();
    maxItems;
    maxBytes;
    measure;
    sequence = 0;
    constructor(options = {}) {
        this.maxItems = normalizeLimit(options.maxItems, DEFAULT_MAX_ITEMS);
        this.maxBytes = normalizeLimit(options.maxBytes, DEFAULT_MAX_BYTES);
        this.measure = options.measure ?? measureValue;
    }
    subscribe(options = {}) {
        const id = `subscriber-${++this.sequence}`;
        const subscription = new StreamSubscription(this, id, {
            maxItems: normalizeLimit(options.maxItems, this.maxItems),
            maxBytes: normalizeLimit(options.maxBytes, this.maxBytes),
            ...(options.filter ? { filter: options.filter } : {}),
        });
        this.subscribers.set(id, subscription);
        return subscription;
    }
    publish(value, byteSize = this.measure(value)) {
        const normalizedSize = Number.isFinite(byteSize) && byteSize >= 0 ? Math.floor(byteSize) : 0;
        this.subscribers.forEach((subscriber) => subscriber.push(value, normalizedSize));
    }
    close() {
        [...this.subscribers.values()].forEach((subscriber) => subscriber.close());
    }
    remove(id) {
        this.subscribers.delete(id);
    }
}
function normalizeLimit(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : fallback;
}
//# sourceMappingURL=subscriber-registry.js.map