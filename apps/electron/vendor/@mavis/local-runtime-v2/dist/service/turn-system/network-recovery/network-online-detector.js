const DEFAULT_TICK_MS = 1_000;
/**
 * An offline wait backs off up to 30 seconds between gateway probes, so on its
 * own it notices a returning network late. The device signals cost no network
 * traffic, so they are read every tick while a wait listens, and a tick that
 * sees them turn from no network to a network tells the waits to retry now.
 * Signals that keep reporting a network, as behind a Wi-Fi whose upstream is
 * down, leave the waits to their backoff. The state when listening starts is
 * the baseline.
 */
export function createNetworkOnlineDetector(options) {
    const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    const listeners = new Set();
    let timer;
    let hadNetwork = false;
    const tick = () => {
        const hasNetwork = options.hasNetwork();
        const returned = hasNetwork && !hadNetwork;
        hadNetwork = hasNetwork;
        if (!returned)
            return;
        for (const listener of [...listeners]) {
            try {
                listener();
            }
            catch {
                // One listener must not keep the others from hearing the network.
            }
        }
    };
    return {
        onOnline(listener) {
            listeners.add(listener);
            if (!timer) {
                hadNetwork = options.hasNetwork();
                timer = setInterval(tick, tickMs);
                timer.unref?.();
            }
            return () => {
                listeners.delete(listener);
                if (listeners.size === 0 && timer) {
                    clearInterval(timer);
                    timer = undefined;
                }
            };
        },
    };
}
//# sourceMappingURL=network-online-detector.js.map