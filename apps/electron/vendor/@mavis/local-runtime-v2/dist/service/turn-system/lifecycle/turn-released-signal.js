/** In-process release notification for Queue-blocking Session ownership. */
export function createTurnReleasedSignal() {
    const listeners = new Set();
    return {
        publish: async (sessionId) => {
            await Promise.allSettled([...listeners].map((listener) => listener(sessionId)));
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}
//# sourceMappingURL=turn-released-signal.js.map