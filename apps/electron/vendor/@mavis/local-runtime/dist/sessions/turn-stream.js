export const SESSION_TURN_REPLAY_MAX_FRAMES = 5_000;
export const SESSION_TURN_REPLAY_MAX_BYTES = 8 * 1024 * 1024;
export class SessionTurnStream {
    turnId;
    limits;
    encoder = new TextEncoder();
    frames = [];
    subscribers = new Set();
    nextSequence = 0;
    retainedBytes = 0;
    replayEvicted = false;
    completed = false;
    constructor(turnId, limits = {
        maxFrames: SESSION_TURN_REPLAY_MAX_FRAMES,
        maxBytes: SESSION_TURN_REPLAY_MAX_BYTES,
    }) {
        this.turnId = turnId;
        this.limits = limits;
    }
    write(input) {
        if (this.completed)
            return;
        const frame = {
            data: input.data,
            cursor: `${this.turnId}:${this.nextSequence}`,
            bytes: this.encoder.encode(input.data).byteLength,
            ...(input.messageId ? { messageId: input.messageId } : {}),
            ...(input.chunkIndex === undefined ? {} : { chunkIndex: input.chunkIndex }),
            completeMessage: input.completeMessage === true,
        };
        this.nextSequence += 1;
        this.frames.push(frame);
        this.retainedBytes += frame.bytes;
        this.pruneReplay();
        for (const subscriber of this.subscribers) {
            this.pushData(subscriber, frame);
        }
    }
    open(anchor, options = {}) {
        const subscriber = {
            queued: [{ kind: 'heartbeat' }],
            waiting: [],
            replayedMessageIds: new Set(anchor?.kind === 'message' ? [anchor.afterMessageId] : undefined),
            chunkCursors: new Map(),
            ...(options.subscriberKey ? { subscriberKey: options.subscriberKey } : {}),
            closed: false,
        };
        const replay = this.replayAfter(anchor);
        if (replay === undefined) {
            subscriber.queued.push({ kind: 'resume-overflow' });
        }
        else {
            for (const frame of replay)
                this.pushData(subscriber, frame);
        }
        if (this.completed) {
            subscriber.queued.push({ kind: 'done' });
            subscriber.closed = true;
        }
        else {
            this.takeOverRawSubscribers(options.subscriberKey);
            this.subscribers.add(subscriber);
        }
        return this.iterable(subscriber);
    }
    checkpoint() {
        const baseline = new Set(this.frames);
        return {
            rollback: () => {
                const retained = this.frames.filter((frame) => baseline.has(frame));
                this.frames.splice(0, this.frames.length, ...retained);
                this.retainedBytes = retained.reduce((total, frame) => total + frame.bytes, 0);
            },
        };
    }
    complete() {
        if (this.completed)
            return;
        this.completed = true;
        for (const subscriber of this.subscribers) {
            this.push(subscriber, { kind: 'done' });
            subscriber.closed = true;
        }
        this.subscribers.clear();
    }
    pruneReplay() {
        while (this.frames.length > this.limits.maxFrames ||
            this.retainedBytes > this.limits.maxBytes) {
            const frame = this.frames.shift();
            if (!frame)
                return;
            this.retainedBytes -= frame.bytes;
            this.replayEvicted = true;
        }
    }
    replayAfter(anchor) {
        if (!anchor)
            return [...this.frames];
        if (anchor.kind === 'cursor') {
            const index = this.frames.findIndex((frame) => frame.cursor === anchor.afterCursor);
            return index < 0 ? undefined : this.frames.slice(index + 1);
        }
        if (this.replayEvicted)
            return undefined;
        const index = this.frames.findIndex((frame) => frame.messageId === anchor.afterMessageId);
        if (index >= 0)
            return this.frames.slice(index + 1);
        return anchor.existsInHistory ? [...this.frames] : undefined;
    }
    publicFrame(frame) {
        return { kind: 'data', data: frame.data, cursor: frame.cursor };
    }
    push(subscriber, frame) {
        const resolve = subscriber.waiting.shift();
        if (resolve) {
            resolve({ done: false, value: frame });
            return;
        }
        subscriber.queued.push(frame);
    }
    pushData(subscriber, frame) {
        if (frame.completeMessage &&
            frame.messageId &&
            subscriber.replayedMessageIds.has(frame.messageId)) {
            return;
        }
        if (!frame.completeMessage && frame.messageId) {
            const replayedChunk = subscriber.chunkCursors.get(frame.messageId);
            if (replayedChunk !== undefined) {
                if ((frame.chunkIndex ?? -1) <= replayedChunk)
                    return;
                subscriber.chunkCursors.delete(frame.messageId);
            }
        }
        this.push(subscriber, this.publicFrame(frame));
        if (frame.completeMessage && frame.messageId) {
            subscriber.replayedMessageIds.add(frame.messageId);
        }
        else if (frame.messageId && frame.chunkIndex !== undefined) {
            const previous = subscriber.chunkCursors.get(frame.messageId) ?? -1;
            if (frame.chunkIndex > previous)
                subscriber.chunkCursors.set(frame.messageId, frame.chunkIndex);
        }
    }
    takeOverRawSubscribers(subscriberKey) {
        if (!subscriberKey)
            return;
        for (const subscriber of this.subscribers) {
            if (!subscriber.subscriberKey || subscriber.subscriberKey === subscriberKey)
                continue;
            this.push(subscriber, { kind: 'done' });
            subscriber.closed = true;
            this.subscribers.delete(subscriber);
        }
    }
    iterable(subscriber) {
        const close = () => {
            subscriber.closed = true;
            this.subscribers.delete(subscriber);
            for (const resolve of subscriber.waiting.splice(0)) {
                resolve({ done: true, value: undefined });
            }
            return { done: true, value: undefined };
        };
        const iterator = {
            [Symbol.asyncIterator]: () => iterator,
            next: () => {
                const frame = subscriber.queued.shift();
                if (frame)
                    return Promise.resolve({ done: false, value: frame });
                if (subscriber.closed)
                    return Promise.resolve({ done: true, value: undefined });
                return new Promise((resolve) => subscriber.waiting.push(resolve));
            },
            return: async () => close(),
        };
        return iterator;
    }
}
//# sourceMappingURL=turn-stream.js.map