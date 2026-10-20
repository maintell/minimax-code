/**
 * T1 — WS connection lifecycle (plan §7).
 *
 * Owns exactly one live WebSocket to the remote gateway:
 *   URL        wss://<endpoint>?binding_id=<id>&ticket=<t>&client_version=<v>&last_event_id=<seq>
 *              (endpoint/ticket/binding_id come fresh from GET /desktop/bindings via the
 *              injected credential provider — never hardcoded; the raw
 *              desktop_device_id never appears on the URL)
 *   handshake  ctrl.hello {connection_id, server_time_ms, max_message_bytes}
 *              → ctrl.auth.complete {last_event_id?} (client_version travels
 *              on the WS URL query only — IDL CtrlAuthCompletePayload)
 *   heartbeat  ctrl.ping every 5s — fixed protocol constant, NOT handed down
 *              by hello (IDL CtrlHelloPayload has no heartbeat_interval_ms);
 *              15s without any inbound frame ⇒ assume dead and reconnect
 *   reconnect  exponential backoff 1/2/4/8/16/30s; EVERY attempt re-fetches a
 *              fresh one-shot ticket through the credential provider; the new
 *              handshake carries last_event_id to request replay
 *   disconnect superseded → quiet stop; auth_expired/ticket_invalid → stop
 *              (owner decides after re-ticketing); app_quit → stop;
 *              server_initiated_unbind → stop + owner clears binding;
 *              server_shutdown / 1006 / anything else → backoff reconnect
 *   health     isRuntimeHealthy() polled while connected; on failure sends
 *              ctrl.disconnect_reason {code: daemon_unavailable}, closes,
 *              then reconnects once health recovers (plan D-15)
 *
 * Inbound cmd.* frames go to the injected CommandRouter (wave 2:
 * command-router.ts). Wave 1 default replies err.<domain>.<action>
 * {code: "NOT_IMPLEMENTED", retryable: false} with in_reply_to = cmd.id.
 */
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { DEFAULT_MAX_MESSAGE_BYTES, FRAME_TYPES, decodeFrame, encodeFrame, errTypeForCmd, isCmdFrame, makeDisconnectReasonFrame, makeFrame, readDisconnectReason, } from './frame-codec.js';
export const BACKOFF_SECONDS = [1, 2, 4, 8, 16, 30];
/** Fixed protocol constant (plan §7 / drift #1): hello does not hand this down. */
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const INBOUND_IDLE_TIMEOUT_MS = 15_000;
export const HANDSHAKE_TIMEOUT_MS = 15_000;
export const HEALTH_CHECK_INTERVAL_MS = 10_000;
export const HEALTH_RECOVERY_POLL_MS = 5_000;
/** Wave-1 placeholder for the wave-2 command-router injection point. */
export function createNotImplementedCommandRouter(logger) {
    return {
        async handleCommand(cmd, reply) {
            logger?.info(`[rc.conn] cmd ${cmd.type} id=${cmd.id} → NOT_IMPLEMENTED (wave 1)`);
            reply(makeFrame(errTypeForCmd(cmd.type), {
                code: 'NOT_IMPLEMENTED',
                message: `${cmd.type} is not implemented in this build`,
                retryable: false,
            }, { inReplyTo: cmd.id, traceId: cmd.trace_id }));
        },
    };
}
export class RcConnection {
    opts;
    wsFactory;
    commandRouter;
    ws = null;
    attemptController = new AbortController();
    state = 'idle';
    stopRequested = false;
    retryAttempt = 0;
    lastEventId;
    maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES;
    lastInboundTs = 0;
    pendingDisconnectReason;
    currentTraceId;
    currentOperationId;
    currentBindingId;
    currentConnectionId;
    attemptStartedAtMs;
    connectedAtMs;
    /** Set by forceClose() so the ensuing handleClose default branch reports a
     * specific reconnect cause (handshake_timeout / idle_timeout) instead of the
     * generic ws_closed. Consumed + cleared on the next handleClose. */
    forcedCloseCause;
    heartbeatTimer = null;
    healthTimer = null;
    handshakeTimer = null;
    retryTimer = null;
    constructor(opts) {
        this.opts = opts;
        this.wsFactory =
            opts.wsFactory ??
                ((url, options) => new WebSocket(url, options ?? { headers: {}, maxPayload: DEFAULT_MAX_MESSAGE_BYTES }));
        this.commandRouter = opts.commandRouter ?? createNotImplementedCommandRouter(opts.logger);
    }
    /** Begin connecting. Idempotent while already active. */
    start() {
        if (this.state !== 'idle' && this.state !== 'stopped')
            return;
        this.opts.logger.info('[rc.conn] start(); beginning connection lifecycle');
        this.stopRequested = false;
        this.retryAttempt = 0;
        void this.attempt();
    }
    /**
     * Collapse the pending backoff and re-attempt immediately. Called by the
     * owner right after the renderer pushes fresh credentials, so we connect
     * with the new one-shot ticket instead of idling out the backoff window
     * (self-heal design §4.3).
     *
     * Only meaningful while `waiting-retry` (a backoff timer is armed). In any
     * other state it is a no-op: `connecting`/`connected` already own an
     * attempt, `stopped`/`idle` have no lifecycle, and `health-gated` is driven
     * by its own recovery poll. This guard also debounces multi-window pushes —
     * N credential broadcasts collapse into one in-flight attempt.
     */
    retryNow() {
        if (this.stopRequested)
            return;
        if (this.state !== 'waiting-retry') {
            this.opts.logger.debug(`[rc.conn] retryNow ignored (state=${this.state})`);
            return;
        }
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        this.opts.logger.info('[rc.conn] retryNow(); fresh credentials arrived, reconnecting now');
        void this.attempt();
    }
    /**
     * Stop for good (no auto-reconnect). Sends ctrl.disconnect_reason with the
     * given reason if the socket is open (app_quit for quit/manual disconnect,
     * per plan §8.1/§8.2).
     */
    stop(reason = 'app_quit') {
        if (this.state === 'stopped' && !this.ws)
            return;
        this.stopRequested = true;
        this.attemptController.abort();
        this.clearAllTimers();
        const ws = this.ws;
        this.ws = null;
        if (ws) {
            if (ws.readyState === WebSocket.OPEN) {
                const frame = makeDisconnectReasonFrame(reason);
                if (this.currentTraceId)
                    frame.trace_id = this.currentTraceId;
                this.sendRaw(ws, frame);
            }
            try {
                // CONNECTING also owns a socket/HTTP upgrade. Revoking callbacks
                // without closing it would leave a late connection alive forever.
                ws.close(1000, reason);
            }
            catch {
                // socket already dying — nothing to clean up
            }
        }
        this.state = 'stopped';
        this.opts.logger.info(`[rc.conn] stopped (reason=${reason})`);
        this.opts.onEvent({ kind: 'stopped', cause: 'requested', reason });
    }
    isConnected() {
        return this.state === 'connected';
    }
    getLastEventId() {
        return this.lastEventId;
    }
    /** Outbound frame API for the owner (wave 2 stream-pump will use this). */
    sendFrame(frame) {
        const ws = this.ws;
        if (!ws || this.state !== 'connected')
            return false;
        return this.sendRaw(ws, frame);
    }
    /**
     * Byte-level outbound path (M3): `text` is a complete, already-serialized
     * envelope — sent verbatim so template-spliced chunk payloads are never
     * re-serialized. Only the max_message_bytes cap is enforced here.
     */
    sendFrameText(text, frameType) {
        const ws = this.ws;
        if (!ws || this.state !== 'connected')
            return { ok: false, reason: 'not_connected' };
        const sizeBytes = Buffer.byteLength(text, 'utf8');
        if (sizeBytes > this.maxMessageBytes) {
            this.opts.logger.warn(`[rc.conn] drop outbound ${frameType}: frame_too_large ${sizeBytes}B > ${this.maxMessageBytes}B`);
            return { ok: false, reason: 'frame_too_large', sizeBytes };
        }
        try {
            ws.send(text);
            return { ok: true };
        }
        catch (err) {
            this.opts.logger.warn(`[rc.conn] send ${frameType} failed: ${connectionErrorForLog(err)}`);
            return { ok: false, reason: 'send_failed' };
        }
    }
    sendRaw(ws, frame) {
        const encoded = encodeFrame(frame, { maxMessageBytes: this.maxMessageBytes });
        if (!encoded.ok) {
            this.opts.logger.error(`[rc.conn] drop outbound ${frame.type}: ${encoded.error.code} ${encoded.error.message}`);
            return false;
        }
        try {
            ws.send(encoded.text);
            return true;
        }
        catch (err) {
            this.opts.logger.warn(`[rc.conn] send ${frame.type} failed: ${connectionErrorForLog(err)}`);
            return false;
        }
    }
    async attempt() {
        if (this.stopRequested)
            return;
        this.attemptController.abort();
        const attemptController = new AbortController();
        this.attemptController = attemptController;
        this.state = 'connecting';
        this.attemptStartedAtMs = Date.now();
        this.connectedAtMs = undefined;
        this.currentConnectionId = undefined;
        this.currentTraceId = `rc-${randomUUID()}`;
        this.currentOperationId = `op-${randomUUID()}`;
        logRcConnectionCase(this.opts.logger, 'info', {
            case_ids: ['A1', 'A2', 'B1', 'B10'],
            stage: 'ws_connect',
            outcome: 'started',
            trace_id: this.currentTraceId,
            rc_operation_id: this.currentOperationId,
            attempt: this.retryAttempt,
            ...(this.lastEventId !== undefined ? { last_event_id: this.lastEventId } : {}),
        });
        this.opts.logger.info(`[rc.conn] connect attempt ${this.retryAttempt} (last_event_id=${this.lastEventId ?? 'none'})`);
        this.opts.onEvent({ kind: 'connecting', attempt: this.retryAttempt });
        let creds;
        try {
            creds = await this.opts.credentials.getCredentials();
        }
        catch (err) {
            if (attemptController.signal.aborted)
                return;
            this.opts.logger.warn(`[rc.conn] credential refresh failed: ${connectionErrorForLog(err)}`);
            this.scheduleRetry('credential_refresh');
            return;
        }
        if (this.stopRequested || attemptController.signal.aborted)
            return;
        this.currentBindingId = creds.state === 'bound' ? creds.bindingId : undefined;
        if (creds.state !== 'bound') {
            // No usable ticket in hand. The main process CANNOT sign GET /desktop/bindings,
            // so instead of building a doomed socket we ask the renderer to re-sign
            // (owner forwards a need-credentials event → rc:refresh-binding). A
            // backoff re-attempt is still armed so a slow/absent renderer never
            // wedges the loop (self-heal design §4.3/§4.5).
            this.scheduleNeedCredentials();
            return;
        }
        let url;
        try {
            const u = new URL(creds.endpoint);
            u.searchParams.set('binding_id', String(creds.bindingId));
            u.searchParams.set('ticket', creds.ticket);
            u.searchParams.set('client_version', this.opts.clientVersion);
            if (this.lastEventId !== undefined) {
                u.searchParams.set('last_event_id', String(this.lastEventId));
            }
            url = u.toString();
        }
        catch (err) {
            this.opts.logger.error(`[rc.conn] invalid endpoint from GET /desktop/bindings: ${connectionErrorForLog(err)}`);
            this.scheduleRetry('invalid_endpoint');
            return;
        }
        this.opts.logger.info(`[rc.conn] event=ws_connect_start trace_id=${this.currentTraceId ?? ''} rc_operation_id=${this.currentOperationId ?? ''} binding_present=true connection_id= endpoint=${endpointForLog(url)}`);
        this.pendingDisconnectReason = undefined;
        let headers = {};
        try {
            // This is intentionally inside attempt(), not the constructor: lane
            // settings can change while the bridge is alive and every retry must
            // use the current value.
            headers = this.opts.getWebSocketHeaders?.() ?? {};
        }
        catch {
            // Header construction is best-effort: provider errors safely degrade to
            // no injected headers. Never include provider error text because it may
            // contain a sensitive value.
            this.opts.logger.warn('[rc.conn] ws header provider failed; using no headers');
        }
        let ws;
        try {
            ws = this.wsFactory(url, {
                headers,
                maxPayload: DEFAULT_MAX_MESSAGE_BYTES,
            });
        }
        catch (err) {
            this.opts.logger.warn(`[rc.conn] ws create failed: ${connectionErrorForLog(err)}`);
            this.scheduleRetry('ws_create_failed');
            return;
        }
        this.ws = ws;
        this.lastInboundTs = Date.now();
        // Gateway must speak first (ctrl.hello); a silent socket is a dead one.
        this.handshakeTimer = setTimeout(() => {
            this.opts.logger.warn('[rc.conn] handshake timeout waiting for ctrl.hello');
            this.forcedCloseCause = 'handshake_timeout';
            this.forceClose(ws);
        }, HANDSHAKE_TIMEOUT_MS);
        ws.on('open', () => {
            this.opts.logger.debug('[rc.conn] ws open; awaiting ctrl.hello');
        });
        ws.on('message', (data) => {
            if (this.ws === ws)
                this.handleMessage(ws, data);
        });
        ws.on('error', (err) => {
            this.opts.logger.warn(`[rc.conn] ws error: ${connectionErrorForLog(err)}`);
        });
        ws.on('close', (code, nativeReason) => {
            if (this.ws === ws)
                this.handleClose(code, nativeReason);
        });
    }
    handleMessage(ws, data) {
        this.lastInboundTs = Date.now();
        const decoded = decodeFrame(typeof data === 'string' ? data : Buffer.isBuffer(data) ? data : String(data), { maxMessageBytes: this.maxMessageBytes });
        if (!decoded.ok) {
            // Malformed frames must never crash the bridge (plan §5 codec rule).
            this.opts.logger.warn(`[rc.conn] drop inbound frame: ${decoded.error.code} ${decoded.error.message}`);
            return;
        }
        const frame = decoded.frame;
        if (typeof frame.event_id === 'number') {
            // Monotonic replay cursor (gateway-assigned).
            this.lastEventId =
                this.lastEventId === undefined
                    ? frame.event_id
                    : Math.max(this.lastEventId, frame.event_id);
        }
        switch (frame.type) {
            case FRAME_TYPES.CTRL_HELLO:
                this.handleHello(ws, frame);
                return;
            case FRAME_TYPES.CTRL_PING:
                this.sendRaw(ws, makeFrame(FRAME_TYPES.CTRL_PONG, {}, { traceId: frame.trace_id ?? this.currentTraceId }));
                return;
            case FRAME_TYPES.CTRL_PONG:
                return; // lastInboundTs already refreshed
            case FRAME_TYPES.CTRL_DISCONNECT_REASON: {
                this.pendingDisconnectReason = readDisconnectReason(frame);
                this.opts.logger.info(`[rc.conn] ctrl.disconnect_reason received: ${disconnectReasonForLog(this.pendingDisconnectReason)}`);
                return;
            }
            case FRAME_TYPES.CTRL_REPLAY_OVERFLOW:
                // IDL: payload is empty {} (drift #3). Semantics: replay is not
                // possible — the only recovery is a full refetch (phone re-pulls its
                // snapshot via cmd.session.list; wave 2 wires that). Wave 1 logs and
                // surfaces the trigger.
                this.opts.logger.warn('[rc.conn] ctrl.replay.overflow — replay window lost; full refetch required');
                this.opts.onEvent({ kind: 'replay-overflow' });
                return;
            default:
                break;
        }
        if (isCmdFrame(frame)) {
            const signal = this.attemptController.signal;
            if (signal.aborted || this.state !== 'connected')
                return;
            this.opts.logger.info(`[rc.conn] event=cmd_in trace_id=${frame.trace_id ?? ''} rc_cmd_id=${frame.id} type=${frame.type}${frame.in_reply_to ? ` in_reply_to=${frame.in_reply_to}` : ''}`);
            void this.commandRouter
                .handleCommand(frame, (reply) => {
                if (!signal.aborted && this.ws === ws)
                    this.sendRaw(ws, reply);
            }, { streamScope: this.currentConnectionId, signal, commandScope: this.opts.commandScope })
                .catch((err) => {
                if (signal.aborted || this.ws !== ws)
                    return;
                this.opts.logger.error(`[rc.conn] command router threw for ${frame.type}: ${connectionErrorForLog(err)}`);
                this.sendRaw(ws, makeFrame(errTypeForCmd(frame.type), { code: 'internal_error', message: 'command handling failed', retryable: true }, { inReplyTo: frame.id, traceId: frame.trace_id }));
            });
            return;
        }
        this.opts.logger.debug(`[rc.conn] ignoring frame type=${frame.type}`);
    }
    handleHello(ws, frame) {
        // One hello owns one socket lifetime. Repeated hello must not silently
        // change the owner of commands already dispatched on that socket.
        if (this.state !== 'connecting' || this.attemptController.signal.aborted)
            return;
        if (this.handshakeTimer) {
            clearTimeout(this.handshakeTimer);
            this.handshakeTimer = null;
        }
        const payload = frame.payload ?? {};
        const connectionId = typeof payload.connection_id === 'string' ? payload.connection_id : '';
        this.currentTraceId = frame.trace_id || this.currentTraceId || `rc-${randomUUID()}`;
        this.currentConnectionId = connectionId || this.currentConnectionId;
        if (typeof payload.max_message_bytes === 'number' && payload.max_message_bytes > 0) {
            this.maxMessageBytes = Math.max(DEFAULT_MAX_MESSAGE_BYTES, payload.max_message_bytes);
        }
        // IDL CtrlHelloPayload third field: server_time_ms. Informational only —
        // logged as clock skew, never drives logic (drift #1; heartbeat is the
        // fixed 15s HEARTBEAT_INTERVAL_MS, not negotiated).
        const clockSkewMs = typeof payload.server_time_ms === 'number' ? payload.server_time_ms - Date.now() : undefined;
        // IDL CtrlAuthCompletePayload carries only last_event_id? — client_version
        // is already on the WS URL query and is NOT repeated here (drift #2).
        const authPayload = {};
        if (this.lastEventId !== undefined)
            authPayload.last_event_id = this.lastEventId;
        this.sendRaw(ws, makeFrame(FRAME_TYPES.CTRL_AUTH_COMPLETE, authPayload, { traceId: this.currentTraceId }));
        this.state = 'connected';
        this.connectedAtMs = Date.now();
        this.retryAttempt = 0;
        this.startHeartbeat();
        this.startHealthWatch();
        this.opts.logger.info(`[rc.conn] event=ws_connected trace_id=${this.currentTraceId ?? ''} rc_operation_id=${this.currentOperationId ?? ''} connection_id=${connectionId} binding_present=${this.currentBindingId !== undefined} clock_skew=${clockSkewMs !== undefined ? `${clockSkewMs}ms` : 'unknown'} max_frame=${this.maxMessageBytes}B last_event_id=${this.lastEventId ?? 'none'}`);
        logRcConnectionCase(this.opts.logger, 'info', {
            case_ids: ['A1', 'A2', 'B1', 'B10'],
            stage: 'ws_connected',
            outcome: 'success',
            ...(this.currentTraceId ? { trace_id: this.currentTraceId } : {}),
            ...(this.currentOperationId ? { rc_operation_id: this.currentOperationId } : {}),
            ...(connectionId ? { connection_id: connectionId } : {}),
            ...(this.attemptStartedAtMs !== undefined
                ? { elapsed_ms: Math.max(0, Date.now() - this.attemptStartedAtMs) }
                : {}),
            ...(this.lastEventId !== undefined ? { last_event_id: this.lastEventId } : {}),
        });
        this.opts.onEvent({ kind: 'connected', connectionId });
    }
    handleClose(code, nativeReason) {
        this.attemptController.abort();
        // While health-gated the recovery poll owns the next attempt — the close
        // we triggered ourselves must not clear its timer.
        if (this.state === 'health-gated')
            return;
        this.clearSocketTimers();
        this.ws = null;
        const reason = this.pendingDisconnectReason;
        const safeReason = disconnectReasonForLog(reason);
        const closeReason = nativeCloseReasonForLog(nativeReason);
        this.pendingDisconnectReason = undefined;
        this.opts.logger.info(`[rc.conn] event=ws_closed trace_id=${this.currentTraceId ?? ''} rc_operation_id=${this.currentOperationId ?? ''} connection_id=${this.currentConnectionId ?? ''} binding_present=${this.currentBindingId !== undefined} code=${code} native_reason=${closeReason ?? 'none'} ctrl_reason=${safeReason}`);
        logRcConnectionCase(this.opts.logger, 'info', {
            case_ids: ['A2', 'B1', 'B10'],
            stage: 'ws_closed',
            outcome: 'observed',
            ...(this.currentTraceId ? { trace_id: this.currentTraceId } : {}),
            ...(this.currentOperationId ? { rc_operation_id: this.currentOperationId } : {}),
            ...(this.currentConnectionId ? { connection_id: this.currentConnectionId } : {}),
            close_code: code,
            ...(reason ? { control_reason: safeReason } : {}),
            ...(this.connectedAtMs !== undefined
                ? { elapsed_ms: Math.max(0, Date.now() - this.connectedAtMs) }
                : {}),
            ...(this.lastEventId !== undefined ? { last_event_id: this.lastEventId } : {}),
        });
        if (this.stopRequested || this.state === 'stopped')
            return;
        switch (reason) {
            case 'superseded':
                // Another connection for this binding took over — exit quietly.
                this.state = 'stopped';
                this.opts.logger.info('[rc.conn] superseded by a newer connection; not reconnecting');
                this.opts.onEvent({ kind: 'stopped', cause: 'superseded', reason });
                return;
            case 'auth_expired':
            case 'ticket_invalid':
                // No blind auto-reconnect: owner re-tickets and decides (plan §7).
                this.state = 'stopped';
                this.opts.logger.warn(`[rc.conn] credentials rejected (${reason}); awaiting owner`);
                this.opts.onEvent({ kind: 'stopped', cause: 'credentials', reason });
                return;
            case 'server_initiated_unbind':
                // IDL DisconnectCode(7): server unbound us — owner clears binding.
                this.state = 'stopped';
                this.opts.logger.info('[rc.conn] server initiated unbind; not reconnecting');
                this.opts.onEvent({ kind: 'stopped', cause: 'server-unbind', reason });
                return;
            case 'app_quit':
                this.state = 'stopped';
                this.opts.onEvent({ kind: 'stopped', cause: 'requested', reason });
                return;
            default: {
                // server_shutdown, abnormal close (1006), network drop, handshake
                // timeout … → reconnect with backoff (fresh ticket per attempt).
                // A forceClose() (handshake/idle) stashes a more specific cause;
                // otherwise this is a gateway/network-driven close.
                const cause = this.forcedCloseCause ?? 'ws_closed';
                this.forcedCloseCause = undefined;
                this.opts.logger.info(`[rc.conn] closed (code=${code}${reason ? `, reason=${safeReason}` : ''}) cause=${cause}; scheduling retry`);
                this.scheduleRetry(cause);
            }
        }
    }
    scheduleRetry(cause) {
        if (this.stopRequested)
            return;
        this.state = 'waiting-retry';
        const delayMs = BACKOFF_SECONDS[Math.min(this.retryAttempt, BACKOFF_SECONDS.length - 1)] * 1000;
        this.retryAttempt += 1;
        this.opts.logger.info(`[rc.conn] event=reconnect_scheduled trace_id=${this.currentTraceId ?? ''} rc_operation_id=${this.currentOperationId ?? ''} connection_id=${this.currentConnectionId ?? ''} binding_present=${this.currentBindingId !== undefined} cause=${cause} attempt=${this.retryAttempt} delay_ms=${delayMs} last_event_id=${this.lastEventId ?? 'none'}`);
        logRcConnectionCase(this.opts.logger, 'info', {
            case_ids: ['A2', 'B1', 'B10'],
            stage: 'ws_retry_scheduled',
            outcome: 'scheduled',
            ...(this.currentTraceId ? { trace_id: this.currentTraceId } : {}),
            ...(this.currentOperationId ? { rc_operation_id: this.currentOperationId } : {}),
            ...(this.currentConnectionId ? { connection_id: this.currentConnectionId } : {}),
            attempt: this.retryAttempt,
            delay_ms: delayMs,
            cause,
            ...(this.lastEventId !== undefined ? { last_event_id: this.lastEventId } : {}),
        });
        this.opts.onEvent({ kind: 'reconnecting', attempt: this.retryAttempt, delayMs, cause });
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            void this.attempt();
        }, delayMs);
    }
    /**
     * No usable ticket: arm a backoff re-attempt AND surface need-credentials so
     * the owner can drive the renderer re-sign loop. `retryNow()` (fired once
     * the renderer pushes fresh credentials) collapses this backoff; otherwise
     * the timer guarantees the loop keeps trying forever with no cap — the only
     * disconnect exit is the renderer reporting state=none (design §2/§4.5).
     */
    scheduleNeedCredentials() {
        if (this.stopRequested)
            return;
        this.state = 'waiting-retry';
        const delayMs = BACKOFF_SECONDS[Math.min(this.retryAttempt, BACKOFF_SECONDS.length - 1)] * 1000;
        this.retryAttempt += 1;
        this.opts.logger.info(`[rc.conn] event=need_credentials trace_id=${this.currentTraceId ?? ''} binding_present=${this.currentBindingId !== undefined} attempt=${this.retryAttempt} delay_ms=${delayMs}`);
        logRcConnectionCase(this.opts.logger, 'warn', {
            case_ids: ['A1', 'A2', 'B1'],
            stage: 'credentials_required',
            outcome: 'blocked',
            ...(this.currentTraceId ? { trace_id: this.currentTraceId } : {}),
            ...(this.currentOperationId ? { rc_operation_id: this.currentOperationId } : {}),
            attempt: this.retryAttempt,
            delay_ms: delayMs,
        });
        this.opts.onEvent({ kind: 'need-credentials', attempt: this.retryAttempt, delayMs });
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            void this.attempt();
        }, delayMs);
    }
    startHeartbeat() {
        if (this.heartbeatTimer)
            clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => {
            const ws = this.ws;
            if (!ws || this.state !== 'connected')
                return;
            if (Date.now() - this.lastInboundTs > INBOUND_IDLE_TIMEOUT_MS) {
                // Gateway went silent past the liveness window — assume dead.
                this.opts.logger.warn('[rc.conn] no inbound frames for 15s; forcing reconnect');
                this.forcedCloseCause = 'idle_timeout';
                this.forceClose(ws);
                return;
            }
            this.sendRaw(ws, makeFrame(FRAME_TYPES.CTRL_PING, {}));
        }, HEARTBEAT_INTERVAL_MS);
    }
    startHealthWatch() {
        if (this.healthTimer)
            clearInterval(this.healthTimer);
        this.healthTimer = setInterval(() => {
            if (this.state !== 'connected')
                return;
            if (this.opts.isRuntimeHealthy())
                return;
            this.tripHealthGate();
        }, HEALTH_CHECK_INTERVAL_MS);
    }
    /** D-15: daemon down → tell the gateway why, close, poll for recovery. */
    tripHealthGate() {
        this.attemptController.abort();
        const ws = this.ws;
        this.clearSocketTimers();
        this.state = 'health-gated';
        this.opts.logger.warn('[rc.conn] local runtime unhealthy; gating WS (daemon_unavailable)');
        logRcConnectionCase(this.opts.logger, 'warn', {
            case_ids: ['A2', 'B1', 'B10'],
            stage: 'runtime_health',
            outcome: 'unhealthy',
            ...(this.currentTraceId ? { trace_id: this.currentTraceId } : {}),
            ...(this.currentOperationId ? { rc_operation_id: this.currentOperationId } : {}),
            ...(this.currentConnectionId ? { connection_id: this.currentConnectionId } : {}),
        });
        if (ws) {
            const frame = makeDisconnectReasonFrame('daemon_unavailable');
            if (this.currentTraceId)
                frame.trace_id = this.currentTraceId;
            this.sendRaw(ws, frame);
            try {
                ws.close(1000, 'daemon_unavailable');
            }
            catch {
                // already closing
            }
        }
        this.ws = null;
        this.opts.onEvent({
            kind: 'reconnecting',
            attempt: 0,
            delayMs: HEALTH_RECOVERY_POLL_MS,
            cause: 'health_recovered',
        });
        this.healthTimer = setInterval(() => {
            if (this.stopRequested) {
                this.clearAllTimers();
                return;
            }
            if (!this.opts.isRuntimeHealthy())
                return;
            if (this.healthTimer) {
                clearInterval(this.healthTimer);
                this.healthTimer = null;
            }
            this.opts.logger.info('[rc.conn] local runtime recovered; reconnecting');
            logRcConnectionCase(this.opts.logger, 'info', {
                case_ids: ['A2', 'B1', 'B10'],
                stage: 'runtime_health',
                outcome: 'recovered',
                ...(this.currentTraceId ? { trace_id: this.currentTraceId } : {}),
                ...(this.currentOperationId ? { rc_operation_id: this.currentOperationId } : {}),
                ...(this.currentConnectionId ? { connection_id: this.currentConnectionId } : {}),
            });
            this.retryAttempt = 0;
            void this.attempt();
        }, HEALTH_RECOVERY_POLL_MS);
    }
    forceClose(ws) {
        if (this.ws === ws)
            this.attemptController.abort();
        try {
            ws.close(1000);
        }
        catch {
            // ignore — close() on a broken socket
        }
        // If the socket never opened, `close` may not fire; treat as closed now.
        if (this.ws === ws && ws.readyState !== WebSocket.OPEN) {
            this.ws = null;
            this.handleClose(1006);
        }
    }
    clearSocketTimers() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        if (this.handshakeTimer) {
            clearTimeout(this.handshakeTimer);
            this.handshakeTimer = null;
        }
        if (this.healthTimer) {
            clearInterval(this.healthTimer);
            this.healthTimer = null;
        }
    }
    clearAllTimers() {
        this.clearSocketTimers();
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
    }
}
function nativeCloseReasonForLog(reason) {
    if (reason === undefined)
        return undefined;
    const text = Buffer.isBuffer(reason) ? reason.toString('utf8') : reason;
    if (!text)
        return undefined;
    return redactConnectionLogValue(text).slice(0, 160);
}
function connectionErrorForLog(error) {
    return redactConnectionLogValue(error instanceof Error ? error.message : String(error));
}
function redactConnectionLogValue(value) {
    return value
        .replace(/(["']?(?:ticket|token|jwt|access_token|refresh_token|credential)["']?\s*[:=]\s*)["']?[^"'\s,&}]+/gi, '$1<redacted>')
        .replace(/(bearer\s+)[^\s"']+/gi, '$1<redacted>');
}
function disconnectReasonForLog(reason) {
    switch (reason) {
        case 'app_quit':
        case 'server_shutdown':
        case 'superseded':
        case 'auth_expired':
        case 'ticket_invalid':
        case 'daemon_unavailable':
        case 'server_initiated_unbind':
            return reason;
        default:
            return reason ? 'unknown' : 'none';
    }
}
function endpointForLog(url) {
    try {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}`;
    }
    catch {
        return '<unparseable-ws-url>';
    }
}
/** Test-case diagnostics must never affect the connection state machine. */
function logRcConnectionCase(logger, level, event) {
    try {
        logger[level](`[RC_CASE] ${JSON.stringify({ ...event, case: event.case_ids.join(',') })}`);
    }
    catch {
        // Diagnostics are deliberately fail-open.
    }
}
//# sourceMappingURL=connection.js.map