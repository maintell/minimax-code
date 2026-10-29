/**
 * Live receive-channel ("transport") state of one polled IM binding — the
 * WeChat iLink long-poll and the Telegram Bot API `getUpdates` loop. It is
 * the source of `IMBindingInfo.transport_status` /
 * `transport_error_category` for those two channels (Feishu keeps its own
 * WS state in `feishu/feishu-sdk-logger.ts`).
 *
 * A bound record only proves that bind succeeded at some point, and the
 * pollers' own lifecycle events prove nothing either: both announce
 * `polling` BEFORE any request went out. So the status here moves only on
 *
 *   - our own start (`connecting`) and intentional stop (`idle`),
 *   - a platform verdict on one getUpdates round (`connected` on a
 *     successful answer, `error` + category on a classified failure),
 *   - the loop failing to start or dying (`error` + `unknown`).
 *
 * States:
 *   - `idle`       — no loop of ours runs: never started, or stopped by us
 *                    (unbind, shutdown, the restart of a wire).
 *   - `connecting` — a start was requested; no getUpdates verdict yet.
 *   - `connected`  — the platform answered a getUpdates round successfully.
 *   - `error`      — the latest verdict was a failure, or the start / loop
 *                    failed. Held after the loop ends until the next start,
 *                    so a dead channel never reads as healthy again.
 *
 * Only a fixed status, a fixed category and an integer HTTP status are
 * kept — never URLs (Telegram puts the bot token in the request path), raw
 * error text or server messages. In memory only: a process restart resets
 * to `idle` until the restore pass starts the loop again.
 */
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
/** Nothing of ours runs for the binding. */
export const IDLE_CHANNEL_TRANSPORT = Object.freeze({
    status: 'idle',
});
const TRANSITION_MESSAGES = {
    wechat: 'WeChat transport status transition',
    telegram: 'Telegram transport status transition',
};
/**
 * Single write path of one binding's {@link ChannelTransportStatusInfo}.
 * Every real change — status, category or HTTP status — is logged as one
 * `<Platform> transport status transition` line; repeated verdicts (every
 * successful poll, the same failure on each retry) are no-ops, so steady
 * polling never logs here. The pollers' own error events already log each
 * failed round.
 */
export class ChannelTransportStatusTracker {
    scope;
    current = IDLE_CHANNEL_TRANSPORT;
    constructor(scope) {
        this.scope = scope;
    }
    snapshot() {
        return this.current;
    }
    toConnecting(reason) {
        this.transition({ status: 'connecting' }, reason);
    }
    toConnected(reason) {
        this.transition({ status: 'connected' }, reason);
    }
    toIdle(reason) {
        this.transition(IDLE_CHANNEL_TRANSPORT, reason);
    }
    toError(reason, errorCategory, httpStatus) {
        this.transition({ status: 'error', errorCategory, ...(httpStatus !== undefined ? { httpStatus } : {}) }, reason);
    }
    transition(next, reason) {
        const prev = this.current;
        if (prev.status === next.status &&
            prev.errorCategory === next.errorCategory &&
            prev.httpStatus === next.httpStatus) {
            return;
        }
        this.current = next;
        const { platform, agentName, clientName } = this.scope;
        logger.info({
            agentName,
            clientName,
            platform,
            prevStatus: prev.status,
            nextStatus: next.status,
            reason,
            ...(next.errorCategory ? { errorCategory: next.errorCategory } : {}),
            ...(next.httpStatus !== undefined ? { httpStatus: next.httpStatus } : {}),
        }, TRANSITION_MESSAGES[platform]);
    }
}
/** Timeout codes Node / undici put on a failed request (on the error or its `cause`). */
const TIMEOUT_CODES = new Set([
    'ETIMEDOUT',
    'ESOCKETTIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
]);
/** Chromium net stack (Electron `net.fetch`) timeouts, e.g. `net::ERR_CONNECTION_TIMED_OUT`. */
const CHROMIUM_TIMEOUT = /\bnet::ERR_(?:CONNECTION_)?TIMED_OUT\b/;
/**
 * Whether a failed request is reliably a timeout: a `TimeoutError`
 * (`AbortSignal.timeout`), a Node / undici timeout code, or a Chromium
 * timeout token. Anything else — including a bare `AbortError`, which is
 * also what our own stop produces — is not claimed as a timeout. Only the
 * verdict leaves this function; the error text is never stored.
 */
export function isNetworkTimeoutError(error) {
    let current = error;
    // fetch wraps the socket error in `cause`, one or two levels deep.
    for (let depth = 0; depth < 3 && current instanceof Error; depth += 1) {
        if (current.name === 'TimeoutError')
            return true;
        const code = current.code;
        if (typeof code === 'string' && TIMEOUT_CODES.has(code))
            return true;
        if (CHROMIUM_TIMEOUT.test(current.message))
            return true;
        current = current.cause;
    }
    return false;
}
//# sourceMappingURL=channel-transport-status.js.map