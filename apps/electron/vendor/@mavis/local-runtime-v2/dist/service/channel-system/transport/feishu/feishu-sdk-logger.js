/**
 * Feishu SDK → pino logger bridge.
 *
 * Migration copy (MR1): extracted from the v1
 * `channels/adapters/feishu/feishu-adapter.ts` header to keep the adapter
 * under the v2 file-size budget. Since reworked so the WS status follows
 * the SDK's real handshake signals and every SDK failure is logged as a
 * safe category (see `feishu-sdk-message-summary.ts`) instead of a bare
 * `sdk_error`.
 */
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
import { renderFeishuSdkMessage, summarizeFeishuSdkMessage, } from './feishu-sdk-message-summary.js';
/**
 * Single write path for {@link FeishuWsLiveState.status}. Logs every real
 * change as `Feishu WS status transition` (plus the safe error summary when
 * entering `error`) and `Feishu WS connected` when a handshake actually
 * completed. That message used to be printed as soon as `start()`
 * returned — before any handshake — which is how a never-connected bot
 * looked healthy in the logs.
 */
export function transitionFeishuWsStatus(input) {
    const { state, agentName, next, reason } = input;
    const prevStatus = state.status;
    // Same-status writes are no-ops: repeated retry verdicts (`error` →
    // `error`) are already logged as SDK lifecycle events, a transition line
    // per retry would only add noise.
    if (prevStatus === next)
        return;
    state.status = next;
    logger.info({
        agentName,
        platform: 'feishu',
        prevStatus,
        nextStatus: next,
        reason,
        ...(next === 'error' ? summaryLogFields(state.lastErrorSummary) : {}),
    }, 'Feishu WS status transition');
    if (next === 'connected') {
        logger.info({ agentName, platform: 'feishu', reason }, 'Feishu WS connected');
    }
}
/**
 * Forget the previous error together with its attempt bookkeeping. Used
 * when a new attempt starts (`startWebSocket`), on teardown, and on a
 * completed handshake — none of them may report an older error as current.
 */
export function clearFeishuWsError(state) {
    state.lastError = undefined;
    state.lastErrorSummary = undefined;
    state.endpointRejectedInAttempt = undefined;
}
/** Public snapshot of the live state for `getWsStatus()` / status APIs. */
export function describeFeishuWsStatus(state) {
    const summary = state.lastErrorSummary;
    return {
        status: state.status,
        ...(state.lastError ? { lastError: state.lastError } : {}),
        ...(summary ? summaryStatusFields(summary) : {}),
    };
}
const LIFECYCLE_MESSAGE = 'Feishu SDK lifecycle event';
/**
 * Build the SDK logger for ONE per-agent `WSClient`. The bridge:
 *
 *   1. never forwards SDK text: every line becomes a fixed
 *      `{ source, agentName, event }` record, and error / warn lines add
 *      the safe summary fields (`errorCategory`, `errorCode`,
 *      `errorCodeName`, `httpStatus`, `errno`, `retryCount`);
 *   2. drives `state.status` from the SDK's real signals — the adapter
 *      constructs the client at `debug` level, otherwise the handshake
 *      lines are filtered out inside the SDK and never reach us;
 *   3. drops debug chatter, above all `receive message ...` (message
 *      frames) and the ws URL in `get connect config success`;
 *   4. refreshes `lastError` / `lastErrorSummary` on every transport error
 *      of the current attempt, except that an endpoint business code is not
 *      replaced by the parse error the SDK logs right after it; errors of
 *      our own event handler or of a single frame write are logged only;
 *   5. once retired (the adapter tore the client down) logs with
 *      `stale: true` and never writes the state again.
 *
 * Exported so the SDK-log-to-pino contract can be unit-tested without
 * pulling in the real `@larksuiteoapi/node-sdk` (which requires network
 * to actually connect).
 */
export function buildFeishuSdkLoggerBridge(input) {
    const scope = {
        agentName: input.agentName,
        state: input.state,
        retired: false,
        logCtx: { source: 'feishu-sdk', agentName: input.agentName },
    };
    return {
        logger: {
            error: (...msg) => onSdkError(scope, msg),
            warn: (...msg) => onSdkWarn(scope, msg),
            info: (...msg) => onSdkInfo(scope, msg),
            debug: (...msg) => onSdkDebug(scope, msg),
            // Never reached: the client runs at `debug`, and the SDK's LoggerProxy
            // filters trace (ping/pong internals) before calling us. Kept because
            // the SDK's Logger shape requires the method.
            trace: () => undefined,
        },
        retire: () => retireBridge(scope),
    };
}
function retireBridge(scope) {
    // Idempotent: a repeated teardown of the same client must not log twice.
    if (scope.retired)
        return;
    scope.retired = true;
    scope.logCtx = { ...scope.logCtx, stale: true };
    logger.info({ ...scope.logCtx, event: 'bridge_retired' }, LIFECYCLE_MESSAGE);
}
/**
 * Errors about our side of a healthy connection, not the transport:
 * `invoke event failed` is OUR event handler throwing (the SDK answers the
 * frame with a 500 and keeps the socket), `send data failed` is one frame
 * write failing — if the socket really broke, the drop arrives separately
 * as `client closed`. Neither may move the status or replace the last
 * transport error: `error` would stick until the next reconnect, which a
 * healthy socket never triggers.
 */
const NON_TRANSPORT_ERRORS = new Set([
    'event_handler_failed',
    'send_failed',
]);
function onSdkError(scope, msg) {
    const summary = summarizeFeishuSdkMessage(msg);
    logger.error({ ...scope.logCtx, event: 'sdk_error', ...summaryLogFields(summary) }, LIFECYCLE_MESSAGE);
    // Retired client: logged above, owns no state any more (see `retire`).
    if (scope.retired)
        return;
    // Handler / frame-write failure on a working socket: logged above only.
    if (NON_TRANSPORT_ERRORS.has(summary.category))
        return;
    const { text } = renderFeishuSdkMessage(msg);
    if (summary.category === 'connect_failed') {
        onFirstConnectFailed(scope, summary, text);
        return;
    }
    recordAttemptError(scope.state, summary, text);
    if (scope.state.status === 'connected') {
        transition(scope, 'error', 'sdk_error_while_connected');
    }
    // Any other status: left alone on purpose. A mid-attempt error is not a
    // verdict; the SDK follows up with `connect failed` (first connect) or
    // `unable to connect ... after trying N times` (reconnect loop), and those
    // lines move the status.
}
function onFirstConnectFailed(scope, summary, text) {
    // First-connect verdict. The SDK prints it right after the error that
    // actually failed the attempt (endpoint code / HTTP / network /
    // handshake); keep that root cause as the status summary and only fall
    // back to this generic line when nothing was captured in this attempt.
    if (!scope.state.lastErrorSummary)
        recordError(scope.state, summary, text);
    endAttempt(scope.state);
    transition(scope, 'error', 'sdk_connect_failed');
}
/**
 * Record one transport error of the current attempt as the latest cause,
 * so the status API shows the most recent failure — except that a business
 * code, once seen in this attempt, wins over the parse error behind it.
 */
function recordAttemptError(state, summary, text) {
    if (summary.category === 'endpoint_response_invalid' && state.endpointRejectedInAttempt) {
        // SDK 1.60.0 returns early only for codes 1 / 1000040343. For any other
        // non-ok code (403, 514, 1000040350, ...) it keeps parsing the reply and
        // throws on the missing `ClientConfig`; that `Cannot read properties
        // ...` line is a symptom of the rejection logged just before, so the
        // business code (and its raw line) stays the recorded cause. The
        // `sdk_error` line above still shows the parse failure.
        return;
    }
    if (summary.category === 'endpoint_rejected')
        state.endpointRejectedInAttempt = true;
    recordError(state, summary, text);
}
/** Attempt verdict reached: the next attempt starts without the code guard. */
function endAttempt(state) {
    state.endpointRejectedInAttempt = undefined;
}
function onSdkWarn(scope, msg) {
    logger.warn({ ...scope.logCtx, event: 'sdk_warning', ...summaryLogFields(summarizeFeishuSdkMessage(msg)) }, LIFECYCLE_MESSAGE);
    // No state change: in SDK 1.60.0 `WSClient` only warns when `start()` gets
    // no event dispatcher, which `startFeishuEventDispatcher` never does; a
    // warning says nothing about the socket either way.
}
/** Info phrases → fixed event names (`unable to connect ...` handled apart). */
const INFO_EVENTS = new Map([
    ['reconnect', 'reconnect_started'],
    // Printed after the FIRST connect attempt whether it succeeded or not —
    // explicitly not a success signal, so it never touches the status.
    ['ws client ready', 'client_ready'],
    ['ws client closed manually', 'client_closed_manually'],
    ['ws client closed manually (force)', 'client_closed_manually'],
]);
function onSdkInfo(scope, msg) {
    const summary = summarizeFeishuSdkMessage(msg);
    const rendered = renderFeishuSdkMessage(msg);
    if (summary.category === 'reconnect_failed') {
        onReconnectAttemptFailed(scope, summary, rendered.text);
        return;
    }
    // Unknown info (e.g. the start-up subscription hint) collapses to
    // `sdk_info`; its text is never forwarded.
    const event = INFO_EVENTS.get(rendered.body) ?? 'sdk_info';
    logger.info({ ...scope.logCtx, event }, LIFECYCLE_MESSAGE);
    if (event === 'reconnect_started')
        onReconnectStarted(scope);
}
function onReconnectStarted(scope) {
    // Retired client: its reconnect loop is logged (stale) but owns no state.
    if (scope.retired)
        return;
    if (scope.state.status === 'connected') {
        // Defensive only: on a drop SDK 1.60.0 logs `client closed` (already
        // → `connecting`) right before `reconnect`. Kept so a future SDK that
        // reorders or drops that line still cannot leave us on `connected`.
        transition(scope, 'connecting', 'sdk_reconnect_started');
    }
    // `error`: the loop follows a failed first connect, so this line brings
    // no new evidence — keep `error`. `connecting`: already reconnecting. The
    // loop's outcome (`ws connect success` / `unable to connect`) decides next.
}
function onReconnectAttemptFailed(scope, summary, text) {
    // Promoted from SDK info to warn: each line is one failed reconnect attempt.
    logger.warn({ ...scope.logCtx, event: 'reconnect_attempt_failed', ...summaryLogFields(summary) }, LIFECYCLE_MESSAGE);
    // Retired client: a loop close() could not cancel keeps retrying; logged
    // above, owns no state.
    if (scope.retired)
        return;
    const rootCause = scope.state.lastErrorSummary;
    if (rootCause) {
        // The SDK prints this right after the error that failed the attempt;
        // keep that cause (and its raw text) and attach the retry counter.
        scope.state.lastErrorSummary = { ...rootCause, retryCount: summary.retryCount };
    }
    else {
        recordError(scope.state, summary, text);
    }
    endAttempt(scope.state);
    transition(scope, 'error', 'sdk_reconnect_failed');
}
/** Debug phrases with lifecycle meaning; every other debug line is dropped. */
const DEBUG_HANDLERS = new Map([
    ['ws connect success', onHandshakeSucceeded],
    ['reconnect success', onReconnectSucceeded],
    ['client closed', onClientClosed],
]);
function onSdkDebug(scope, msg) {
    const { body } = renderFeishuSdkMessage(msg);
    const handler = DEBUG_HANDLERS.get(body);
    if (handler) {
        handler(scope);
        return;
    }
    if (!body.startsWith('get connect config success')) {
        // Dropped on purpose: `receive message ...` fires per inbound frame and
        // interpolates message / trace ids plus the event's `data` field;
        // `repeat connection`, DataCache expiry notes and unknown debug lines
        // are internal chatter with no state meaning, and forwarding them would
        // flood the log at debug volume.
        return;
    }
    // The endpoint handed out a ws URL. Log the milestone only — the URL
    // itself carries the connection ticket.
    logger.info({ ...scope.logCtx, event: 'connect_config_ok' }, LIFECYCLE_MESSAGE);
}
function onHandshakeSucceeded(scope) {
    logger.info({ ...scope.logCtx, event: 'connect_succeeded' }, LIFECYCLE_MESSAGE);
    if (scope.retired) {
        warnStaleClientConnected(scope);
        return;
    }
    // A completed handshake supersedes whatever failed earlier in the attempt.
    clearFeishuWsError(scope.state);
    transition(scope, 'connected', 'sdk_connect_success');
}
function warnStaleClientConnected(scope) {
    // A socket opened AFTER the adapter closed this client — the close race
    // described on `retire`, via the first connect or the loop it started.
    // Nothing holds this client any more, so the connection is leaked and
    // keeps receiving (and acking) events. The leak itself is an existing SDK
    // defect, deliberately not worked around here; this line makes it visible.
    logger.warn({ ...scope.logCtx, event: 'stale_client_connected' }, 'Feishu WS stale client connected after teardown (SDK close race, leaked connection)');
}
function onReconnectSucceeded(scope) {
    logger.info({ ...scope.logCtx, event: 'reconnect_succeeded' }, LIFECYCLE_MESSAGE);
    // Retired client: the same attempt's `ws connect success` already warned.
    if (scope.retired)
        return;
    // lastError untouched (pre-existing semantics); the same attempt's
    // `ws connect success`, printed by `connect()` just before, cleared it.
    transition(scope, 'connected', 'sdk_reconnect_success');
}
function onClientClosed(scope) {
    logger.info({ ...scope.logCtx, event: 'client_closed' }, LIFECYCLE_MESSAGE);
    // Retired client: a leaked socket dropping says nothing about ours.
    if (scope.retired)
        return;
    // SDK 1.60.0 prints this only from the socket's own `close` listener and
    // calls `reConnect()` right after; a manual `close()` removes that
    // listener first. So it means "dropped by the server / network, now
    // reconnecting" — `connecting`, not `idle`. lastError is kept so the drop
    // cause (e.g. a preceding `ws error`) stays visible until a reconnect
    // succeeds.
    transition(scope, 'connecting', 'sdk_client_closed');
}
function transition(scope, next, reason) {
    transitionFeishuWsStatus({ state: scope.state, agentName: scope.agentName, next, reason });
}
function recordError(state, summary, text) {
    state.lastError = text;
    state.lastErrorSummary = summary;
}
/**
 * Safe summary → log fields. Shared by every bridge / transition line so a
 * single grep key (`errorCategory`) finds all of them.
 */
function summaryLogFields(summary) {
    if (!summary)
        return {};
    return {
        errorCategory: summary.category,
        ...(summary.code !== undefined ? { errorCode: summary.code } : {}),
        ...(summary.codeName ? { errorCodeName: summary.codeName } : {}),
        ...(summary.httpStatus !== undefined ? { httpStatus: summary.httpStatus } : {}),
        ...(summary.errno ? { errno: summary.errno } : {}),
        ...(summary.retryCount !== undefined ? { retryCount: summary.retryCount } : {}),
    };
}
/** Safe summary → the `lastError*` fields of {@link FeishuWsStatusInfo}. */
function summaryStatusFields(summary) {
    return {
        lastErrorCategory: summary.category,
        ...(summary.code !== undefined ? { lastErrorCode: summary.code } : {}),
        ...(summary.codeName ? { lastErrorCodeName: summary.codeName } : {}),
        ...(summary.httpStatus !== undefined ? { lastErrorHttpStatus: summary.httpStatus } : {}),
        ...(summary.errno ? { lastErrorErrno: summary.errno } : {}),
        ...(summary.retryCount !== undefined ? { lastErrorRetryCount: summary.retryCount } : {}),
    };
}
//# sourceMappingURL=feishu-sdk-logger.js.map