export const noopLogger = {
    debug: (..._args) => { },
    error: (..._args) => { },
    info: (..._args) => { },
    warn: (..._args) => { },
};
export const defaultNowMs = () => Date.now();
/**
 * Default per-call LLM HTTP timeout (ms) injected into every provider
 * stream invocation via `wrapStreamFnWithTimeout`. 20 minutes is long
 * enough for thinking turns without letting a wedged provider hang the
 * agent loop indefinitely.
 *
 * Per-call upstream wrappers that explicitly set `options.timeoutMs` win.
 */
export const LLM_REQUEST_TIMEOUT_MS = 20 * 60 * 1000;
export const defaultMessageIdAllocator = {
    async allocateAssistantMessageId() {
        // crypto.randomUUID is available in Node >=18 and modern runtimes.
        return (globalThis.crypto?.randomUUID?.() ??
            `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    },
};
//# sourceMappingURL=defaults.js.map