/**
 * Feishu SDK → pino logger bridge.
 *
 * Migration copy (MR1): extracted from the v1
 * `channels/adapters/feishu/feishu-adapter.ts` header to keep the adapter
 * under the v2 file-size budget; contents unchanged.
 */
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
/**
 * Build a {@link FeishuSdkLoggerBridge} for a specific per-agent WS
 * client. The bridge:
 *
 *   1. emits a stable `{ source, agentName, event }` record instead of
 *      SDK-provided text;
 *   2. promotes `[ws] client closed`, `[ws] ws connect success`, and
 *      `[ws] reconnect success` from SDK debug to our info level so
 *      the important runtime lifecycle transitions land at the default
 *      log level (they would otherwise be silent by default);
 *   3. updates the adapter's `wsStatus` on the transitions we can
 *      detect from string matching:
 *        - `error` on SDK error (unless we're already reconnecting)
 *        - `connecting` on `[ws] reconnect` (started reconnection loop)
 *        - `connected` on `[ws] reconnect success`
 *        - `idle` on `[ws] client closed`
 *      so the status API stops echoing "connected: true" during a
 *      reconnect window;
 *   4. drops SDK trace (ping/pong internals) — high volume, low signal.
 *
 * Exported so the SDK-log-to-pino contract can be unit-tested without
 * pulling in the real `@larksuiteoapi/node-sdk` (which requires network
 * to actually connect).
 */
export function buildFeishuSdkLoggerBridge(input) {
    const { agentName, getStatus, setStatus } = input;
    const bridgeCtx = { source: 'feishu-sdk', agentName };
    const logMessage = 'Feishu SDK lifecycle event';
    const stringify = (msg) => msg
        .map((m) => {
        if (typeof m === 'string')
            return m;
        if (m instanceof Error)
            return m.message;
        try {
            return JSON.stringify(m);
        }
        catch {
            return String(m);
        }
    })
        .join(' ');
    return {
        error: (...msg) => {
            const rendered = stringify(msg);
            logger.error({ ...bridgeCtx, event: 'sdk_error' }, logMessage);
            // Surface into wsStatus so the status API + retry decisions see
            // "the SDK just yelled at us". Only overwrite the connected state
            // — if we're already reconnecting, a downstream SDK-side warning
            // is part of that loop, not a fresh terminal error.
            if (getStatus() === 'connected') {
                setStatus('error', rendered);
            }
        },
        warn: () => {
            logger.warn({ ...bridgeCtx, event: 'sdk_warning' }, logMessage);
        },
        info: (...msg) => {
            const rendered = stringify(msg);
            const isReconnectStarted = rendered.includes('reconnect') && !rendered.includes('success');
            logger.info({ ...bridgeCtx, event: isReconnectStarted ? 'reconnect_started' : 'sdk_info' }, logMessage);
            // `[ws] reconnect` fires when the SDK gives up the current socket
            // and starts a reconnection loop. Flip our status so callers stop
            // echoing 'connected' during the retry window.
            if (isReconnectStarted) {
                if (getStatus() === 'connected') {
                    setStatus('connecting', rendered);
                }
            }
        },
        debug: (...msg) => {
            const rendered = stringify(msg);
            if (rendered.includes('client closed')) {
                logger.info({ ...bridgeCtx, event: 'client_closed' }, logMessage);
                if (getStatus() !== 'idle') {
                    setStatus('idle', undefined);
                }
            }
            else if (rendered.includes('reconnect success')) {
                logger.info({ ...bridgeCtx, event: 'reconnect_succeeded' }, logMessage);
                setStatus('connected', undefined);
            }
            else if (rendered.includes('ws connect success')) {
                logger.info({ ...bridgeCtx, event: 'connect_succeeded' }, logMessage);
            }
            else {
                logger.info({ ...bridgeCtx, event: 'sdk_info' }, logMessage);
            }
        },
        trace: () => {
            // Ping/pong internals — high volume, low signal. Dropped.
        },
    };
}
//# sourceMappingURL=feishu-sdk-logger.js.map