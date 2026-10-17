/** Hardcoded defaults — server-level fields fall back to these when not set. */
export const MCP_DEFAULTS = {
    /** Per-call timeout in ms; tuned for matrix biz-gateway worst-case multimodal RPCs. */
    timeout: 120_000,
    /** Per-server semaphore size. */
    maxConcurrency: 5,
};
export const NOOP_MCP_RUNTIME_LOGGER = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};
//# sourceMappingURL=types.js.map