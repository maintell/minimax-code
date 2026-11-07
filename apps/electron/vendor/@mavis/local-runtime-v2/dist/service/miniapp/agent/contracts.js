/** Runs of one plugin at once when its manifest omits `agentConcurrency`; matches subagents. */
export const MINIAPP_AGENT_DEFAULT_CONCURRENCY = 4;
/** Largest manifest `agentConcurrency`. */
export const MINIAPP_AGENT_MAX_CONCURRENCY = 32;
/**
 * `run` / `answer` calls that may wait, in FIFO order, for one of the plugin's run slots:
 * this many times its concurrency.
 */
export const MINIAPP_AGENT_QUEUE_FACTOR = 4;
/**
 * Turns one plugin may start per sliding window, charged when a run slot is taken: the floor of a
 * limit that grows with `agentConcurrency` (`MINIAPP_AGENT_RATE_PER_SLOT` per slot, so a full
 * queue can always drain within one window). Counted per plugin, so a process generation change
 * does not reset it.
 */
export const MINIAPP_AGENT_MAX_STARTS_PER_MINUTE = 12;
export const MINIAPP_AGENT_RATE_PER_SLOT = 1 + MINIAPP_AGENT_QUEUE_FACTOR;
export const MINIAPP_AGENT_RATE_WINDOW_MS = 60_000;
/** Concurrent `observe` subscriptions one plugin may hold; separate from the run slots. */
export const MINIAPP_AGENT_MAX_OBSERVERS_PER_PLUGIN = 4;
/** Most recently updated user sessions `sessions.list` returns. */
export const MINIAPP_AGENT_SESSION_LIST_LIMIT = 50;
/** Session purpose label only; Mini App sessions resolve their prompt surface like any other. */
export const MINIAPP_AGENT_PURPOSE_PREFIX = 'miniapp:';
/** Agent for new Mini App sessions without a host chat session (`PRIMARY_AGENT_NAME`). */
export const MINIAPP_AGENT_NAME = 'mavis';
export function isMiniAppAgentWhenBusy(value) {
    return value === 'queue' || value === 'steer';
}
export const MINIAPP_AGENT_ERROR_CODES = [
    'NOT_PERMITTED',
    'BUSY',
    'SESSION_NOT_FOUND',
    'INVALID_ARGUMENTS',
    'AGENT_UNAVAILABLE',
    'REQUEST_CANCELLED',
    'AGENT_OUTCOME_UNKNOWN',
    'REQUEST_NOT_FOUND',
];
export function isMiniAppAgentBusyReason(value) {
    return (value === 'session_busy' ||
        value === 'queue_full' ||
        value === 'rate_limited' ||
        value === 'observer_limit');
}
export class MiniAppAgentError extends Error {
    name = 'MiniAppAgentError';
    code;
    retryable;
    constructor(code, message, retryable = false, reason) {
        super(message);
        this.code = code;
        this.retryable = retryable;
        if (reason !== undefined)
            this.reason = reason;
    }
}
//# sourceMappingURL=contracts.js.map