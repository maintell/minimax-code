/** Runs of one plugin at once when its manifest omits `agentConcurrency`; matches subagents. */
export const MINIAPP_AGENT_DEFAULT_CONCURRENCY = 4;
/** Largest manifest `agentConcurrency`. */
export const MINIAPP_AGENT_MAX_CONCURRENCY = 32;
/**
 * `run` / `answer` calls that may wait, in FIFO order, for one of the plugin's run slots:
 * this many times its concurrency.
 */
export const MINIAPP_AGENT_QUEUE_FACTOR = 4;
/** Session purpose label only; Mini App sessions resolve their prompt surface like any other. */
export const MINIAPP_AGENT_PURPOSE_PREFIX = 'miniapp:';
/** Agent for new Mini App sessions without a host chat session (`PRIMARY_AGENT_NAME`). */
export const MINIAPP_AGENT_NAME = 'mavis';
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
    return value === 'session_busy' || value === 'queue_full';
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