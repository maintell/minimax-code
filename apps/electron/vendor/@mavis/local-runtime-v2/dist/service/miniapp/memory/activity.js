/** Streaming subscription: counted once when its request is admitted, never in flight while open. */
const OBSERVE_METHOD = 'agent.observe';
const IDLE = Object.freeze({ inFlight: 0 });
/**
 * Host-observed request activity per plugin. Every method counts the same; only the Host's own
 * view of in-flight requests decides it, so a plugin cannot report or forge it.
 */
export function createMiniAppHostRequestActivityTracker(options = {}) {
    const nowMs = options.nowMs ?? Date.now;
    const plugins = new Map();
    const entryFor = (pluginId) => {
        let entry = plugins.get(pluginId);
        if (!entry) {
            entry = { inFlight: 0 };
            plugins.set(pluginId, entry);
        }
        return entry;
    };
    return {
        requestStarted(pluginId, method) {
            const entry = entryFor(pluginId);
            if (method === OBSERVE_METHOD) {
                entry.lastEndedAtMs = nowMs();
                return;
            }
            entry.inFlight += 1;
        },
        requestEnded(pluginId, method) {
            if (method === OBSERVE_METHOD)
                return;
            const entry = plugins.get(pluginId);
            // An end without a matching start never drives the count below zero or extends activity.
            if (!entry || entry.inFlight === 0)
                return;
            entry.inFlight -= 1;
            entry.lastEndedAtMs = nowMs();
        },
        read(pluginId) {
            const entry = plugins.get(pluginId);
            if (!entry)
                return IDLE;
            return {
                inFlight: entry.inFlight,
                ...(entry.lastEndedAtMs !== undefined ? { lastEndedAtMs: entry.lastEndedAtMs } : {}),
            };
        },
    };
}
//# sourceMappingURL=activity.js.map