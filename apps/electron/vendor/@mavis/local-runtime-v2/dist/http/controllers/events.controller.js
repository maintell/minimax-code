import { EventsControllerBase } from '../generated/events-controller-base.gen.js';
const HEARTBEAT_INTERVAL_MS = 30_000;
// Per-connection transport backpressure only: overflow ends the live stream; nothing is replayed.
const MAX_PENDING_FRAMES = 256;
class EventsController extends EventsControllerBase {
    facade;
    nowMs;
    constructor(facade, nowMs) {
        super();
        this.facade = facade;
        this.nowMs = nowMs;
    }
    async subscribeGlobalEvents(_ctx, _req) {
        return { ok: true, source: createEventFrames(this.facade, this.nowMs) };
    }
}
export function createEventsController(facade, nowMs = Date.now) {
    return new EventsController(facade, nowMs);
}
function createEventFrames(facade, nowMs) {
    return {
        [Symbol.asyncIterator]() {
            const pending = [{ kind: 'heartbeat', timestamp: nowMs() }];
            let resolveNext;
            let unsubscribe;
            let unsubscribeAfterSubscribe = false;
            let closed = false;
            const push = (frame) => {
                if (closed)
                    return;
                if (resolveNext) {
                    const resolve = resolveNext;
                    resolveNext = undefined;
                    resolve({ done: false, value: frame });
                    return;
                }
                if (pending.length >= MAX_PENDING_FRAMES) {
                    close();
                    return;
                }
                pending.push(frame);
            };
            const close = () => {
                if (closed)
                    return;
                closed = true;
                clearInterval(heartbeat);
                if (unsubscribe) {
                    const unsubscribeNow = unsubscribe;
                    unsubscribe = undefined;
                    unsubscribeNow();
                }
                else {
                    unsubscribeAfterSubscribe = true;
                }
                resolveNext?.({ done: true, value: undefined });
                resolveNext = undefined;
                pending.length = 0;
            };
            const heartbeat = setInterval(() => push({ kind: 'heartbeat', timestamp: nowMs() }), HEARTBEAT_INTERVAL_MS);
            const subscriber = {
                next: (event) => {
                    push({
                        kind: 'event',
                        timestamp: event.timestamp,
                        type: event.type,
                        source: event.source,
                        payloadJson: JSON.stringify(event.payload),
                    });
                },
                complete: close,
            };
            unsubscribe = facade.subscribe(subscriber);
            if (unsubscribeAfterSubscribe) {
                const unsubscribeNow = unsubscribe;
                unsubscribe = undefined;
                unsubscribeNow();
            }
            return {
                next() {
                    const frame = pending.shift();
                    if (frame)
                        return Promise.resolve({ done: false, value: frame });
                    if (closed)
                        return Promise.resolve({ done: true, value: undefined });
                    return new Promise((resolve) => {
                        resolveNext = resolve;
                    });
                },
                return() {
                    close();
                    return Promise.resolve({ done: true, value: undefined });
                },
            };
        },
    };
}
//# sourceMappingURL=events.controller.js.map