/** Process-local notification emitted only after at least one Usage row is stored. */
export function createSessionUsageCommitSignal() {
    const listeners = new Set();
    return {
        publish: (sessionId) => {
            for (const listener of listeners) {
                try {
                    listener(sessionId);
                }
                catch {
                    // Live consumers cannot affect the best-effort Usage projection.
                }
            }
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}
//# sourceMappingURL=commit-signal.js.map