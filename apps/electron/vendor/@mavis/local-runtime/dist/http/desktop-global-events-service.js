const HEARTBEAT_INTERVAL_MS = 30_000;
// Per-connection transport backpressure only: overflow ends the live stream; nothing is replayed.
const MAX_PENDING_FRAMES = 256;
export class DesktopGlobalEventsService {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    subscribeGlobalEvents(ctx, req) {
        void ctx;
        void req;
        if (!this.deps) {
            return Promise.resolve({
                ok: false,
                status: 503,
                body: {
                    code: 503,
                    key: 'GLOBAL_EVENTS_UNAVAILABLE',
                    message: 'Desktop global events service is not configured',
                },
            });
        }
        return Promise.resolve({ ok: true, source: createGlobalEventFrames(this.deps) });
    }
}
function createGlobalEventFrames(deps) {
    return {
        [Symbol.asyncIterator]() {
            const pending = [{ kind: 'heartbeat', timestamp: deps.nowMs() }];
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
            const heartbeat = setInterval(() => push({ kind: 'heartbeat', timestamp: deps.nowMs() }), HEARTBEAT_INTERVAL_MS);
            unsubscribe = deps.subscribe({
                next: (event) => {
                    push({
                        kind: 'event',
                        timestamp: deps.nowMs(),
                        type: event.type,
                        source: 'local-runtime',
                        payloadJson: JSON.stringify(event.payload),
                    });
                },
                complete: close,
            });
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
//# sourceMappingURL=desktop-global-events-service.js.map