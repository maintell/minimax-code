/**
 * One extension's view of a shared group host. Every request carries the extension's slot, so
 * the existing provider, credential, login and transport proxies work unchanged on top of it.
 * Stream credits and login flow events are keyed by request id / flow ref, which are already
 * unique per process.
 */
export function slotPeer(peer, slot) {
    return {
        get epoch() {
            return peer.epoch;
        },
        get closed() {
            return peer.closed;
        },
        waitForHello: (timeoutMs) => peer.waitForHello(timeoutMs),
        waitForReady: (timeoutMs) => peer.waitForReady(timeoutMs),
        request: (method, params, options = {}) => peer.request(method, params, { ...options, slot }),
        requestStream: (method, params, options = {}) => peer.requestStream(method, params, { ...options, slot }),
        subscribeFlow: (flowRef, listener) => peer.subscribeFlow(flowRef, listener),
        credit: (id, n) => peer.credit(id, n),
        // A slot never closes the shared process; the group host owns its lifetime.
        close: () => { },
    };
}
//# sourceMappingURL=slot-peer.js.map