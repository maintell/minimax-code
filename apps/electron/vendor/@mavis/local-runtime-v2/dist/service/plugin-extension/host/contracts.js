/** Chain order from outside to inside; core is always innermost and is not a tier. */
export const EXTENSION_TIER_ORDER = ['preview', 'installed'];
/** Phase-one initial values (two.md §15). */
export const HOST_LIMITS = Object.freeze({
    ownTimeBudgetMs: 10_000,
    renderDeadlineMs: 30_000,
    syncTimeoutMs: 2_000,
    heartbeatIntervalMs: 1_000,
    heartbeatTimeoutMs: 10_000,
    breakerThreshold: 3,
    suspectThreshold: 2,
    unattributedWindowMs: 10 * 60_000,
    handleTtlMs: 2_000,
    gestureQueueCapacity: 10,
    observeQueueCapacity: 32,
    maxDirtyReruns: 3,
    resourceLimitMb: 256,
    consolePerMinute: 200,
    minClockIntervalMs: 1_000,
    diagnosticsCapacity: 500,
    tracesCapacity: 200,
});
//# sourceMappingURL=contracts.js.map