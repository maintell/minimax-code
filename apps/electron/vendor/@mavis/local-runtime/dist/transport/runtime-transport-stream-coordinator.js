/**
 * Owns single-flight state above individual MessagePort hosts. A renderer
 * reconnect or a second window must supersede the same long-lived endpoint,
 * while releasing a stale claim must never remove a newer claimant.
 */
export function createRuntimeTransportStreamCoordinator() {
    const active = new Map();
    return {
        claim(key, onSuperseded) {
            active.get(key)?.onSuperseded();
            let released = false;
            const claim = {};
            claim.onSuperseded = onSuperseded;
            claim.release = () => {
                if (released)
                    return;
                released = true;
                if (active.get(key) === claim)
                    active.delete(key);
            };
            active.set(key, claim);
            return claim.release;
        },
        clear() {
            active.clear();
        },
    };
}
//# sourceMappingURL=runtime-transport-stream-coordinator.js.map