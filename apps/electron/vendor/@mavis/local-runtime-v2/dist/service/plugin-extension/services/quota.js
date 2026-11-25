/** Per-plugin, per-minute quotas (two.md §3 调用入口检查). */
export const EXTENSION_QUOTAS = {
    mcpCall: 60,
    toast: 6,
};
const WINDOW_MS = 60_000;
/** Sliding one-minute window keyed by plugin id, on an injected clock. */
export class PerPluginRateLimiter {
    limit;
    now;
    hits = new Map();
    dropping = new Set();
    constructor(limit, now = Date.now) {
        this.limit = limit;
        this.now = now;
    }
    tryTake(pluginId) {
        return this.take(pluginId) === 'allowed';
    }
    take(pluginId) {
        const now = this.now();
        const recent = (this.hits.get(pluginId) ?? []).filter((at) => now - at < WINDOW_MS);
        this.hits.set(pluginId, recent);
        if (recent.length < this.limit) {
            recent.push(now);
            this.dropping.delete(pluginId);
            return 'allowed';
        }
        if (this.dropping.has(pluginId))
            return 'dropped';
        this.dropping.add(pluginId);
        return 'first-drop';
    }
}
//# sourceMappingURL=quota.js.map