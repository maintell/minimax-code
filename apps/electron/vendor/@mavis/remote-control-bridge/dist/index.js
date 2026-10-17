/**
 * T1 — RemoteControlProxy facade (plan §8).
 *
 * Aggregates device-identity + pairing-client + connection into the three
 * control-plane operations exposed to Electron (via ipc.ts):
 *
 *   connect()                — §8.2 orchestration: ensure device_id →
 *                              GET /binding → bound? direct WS : pairing flow
 *                              (POST /pairing/code → 1Hz poll until bound,
 *                              code expiry rolls back to none and re-issues)
 *   disconnect({unbind?})    — WS teardown; unbind=true additionally
 *                              POST /unbind {binding_id} + clears state.json
 *                              binding fields → phase 'unbound'
 *   getStatus()/onStatusChange — RCStatus snapshot + push
 *
 * Bind/unbind deliberately have no standalone API (§8.1 fold table).
 */
import { createCredentialProvider } from './credential.js';
import { describeBindingForLog } from './audit-redaction.js';
import { FRAME_TYPES, makeFrame } from './frame-codec.js';
import { createCommandRouter } from './command-router.js';
import { PermissionUpstream } from './permission-upstream.js';
import { RcConnection } from './connection.js';
import { StreamPump } from './stream-pump.js';
import { PairingClientError } from './pairing-client.js';
export const DEFAULT_PAIRING_POLL_INTERVAL_MS = 1_000;
/** Give up pairing polling after this many consecutive HTTP failures. */
const MAX_CONSECUTIVE_POLL_FAILURES = 30;
/** Floor between two pairing-code re-issues (guards against server churn). */
const MIN_CODE_REISSUE_INTERVAL_MS = 5_000;
const STILL_PAIRING_LOG_INTERVAL_MS = 15_000;
export class RemoteControlProxy {
    opts;
    status = { phase: 'idle' };
    listeners = new Set();
    pollIntervalMs;
    connection = null;
    connectInFlight = null;
    pollTimer = null;
    pollBusy = false;
    pollFailures = 0;
    codeDeadlineMs = null;
    lastCodeIssueMs = 0;
    lastStillPairingLogMs = 0;
    /**
     * Credentials that the renderer has already fetched (with its own token).
     * When present, the credential provider returns them directly — skipping
     * the main-process `GET /binding` call that would otherwise hit archon_biz
     * with the storage.ipc token and risk 401 if it has drifted.
     */
    rendererCredentials = null;
    /** Wave-2 data plane (router + pump + permission upstream) — see opts doc. */
    dataPlane;
    constructor(opts) {
        this.opts = opts;
        this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_PAIRING_POLL_INTERVAL_MS;
        if (opts.localRuntimeInvoke || opts.globalEventSource) {
            // Live sender facade: pump/upstream hold it across reconnects; it
            // always routes to the connection instance that is current NOW.
            const sender = {
                isConnected: () => this.connection?.isConnected() ?? false,
                sendFrame: (frame) => this.connection?.sendFrame(frame) ?? false,
                sendFrameText: (text, frameType) => this.connection?.sendFrameText(text, frameType) ?? {
                    ok: false,
                    reason: 'not_connected',
                },
            };
            const dataPlane = {};
            dataPlane.sender = sender;
            if (opts.localRuntimeInvoke) {
                const pump = new StreamPump({ sender, logger: opts.logger });
                dataPlane.pump = pump;
                dataPlane.router = createCommandRouter({
                    invoke: opts.localRuntimeInvoke,
                    pump,
                    logger: opts.logger,
                    ...(opts.getRemoteControlFileContentMaxBytes
                        ? { getRemoteControlFileContentMaxBytes: opts.getRemoteControlFileContentMaxBytes }
                        : {}),
                    ...(opts.attachmentFetcher ? { attachments: opts.attachmentFetcher } : {}),
                    ...(opts.onSessionComposerModeChange
                        ? { onSessionComposerModeChange: opts.onSessionComposerModeChange }
                        : {}),
                });
            }
            if (opts.globalEventSource) {
                dataPlane.upstream = new PermissionUpstream({
                    eventSource: opts.globalEventSource,
                    sender,
                    getActiveCmdId: (sessionId) => dataPlane.pump?.getActiveCmdId(sessionId, dataPlane.activeStreamScope),
                    logger: opts.logger,
                });
            }
            this.dataPlane = dataPlane;
        }
    }
    getStatus() {
        return {
            ...this.status,
            ...(this.status.last_error ? { last_error: { ...this.status.last_error } } : {}),
        };
    }
    /** Broadcast a Desktop-owned temporary composer choice to the bound phone. */
    publishSessionComposerMode(change) {
        const sender = this.dataPlane?.sender;
        if (!sender?.isConnected())
            return false;
        return sender.sendFrame(makeFrame(FRAME_TYPES.EVT_SESSION_COMPOSER_MODE_CHANGED, {
            session_id: change.sessionId,
            mode: change.mode,
        }));
    }
    /** Stable device UUID for X-Device-Id header. */
    getDeviceId() {
        this.opts.identity.ensure();
        return this.opts.identity.getDeviceId();
    }
    /** Read-only view of the persisted binding owner (for account-switch checks). */
    getBoundUserState() {
        const state = this.opts.identity.getState();
        return {
            ...(state.binding_id !== undefined ? { binding_id: state.binding_id } : {}),
            ...(state.bound_user_id !== undefined ? { bound_user_id: state.bound_user_id } : {}),
        };
    }
    /**
     * Receive the binding credentials the renderer just fetched via its own
     * (matrix-signed) `GET /binding` call. Subsequent WS connect attempts
     * consume these directly through the credential provider, so the main
     * process does NOT have to re-hit /binding (which it cannot sign).
     *
     * With an existing connection, fresh credentials for the same binding only
     * collapse a pending backoff via `retryNow()`. A different `binding_id` must
     * replace the connection via `startConnection()`, which stops the old WS and
     * starts a new one with the newly cached credentials.
     */
    applyRendererCredentials(creds) {
        const previousBindingId = this.status.binding_id ?? this.opts.identity.getState().binding_id;
        this.rendererCredentials = {
            bindingId: creds.binding_id,
            ticket: creds.ticket,
            endpoint: creds.endpoint,
            fetchedAtMs: Date.now(),
        };
        this.opts.identity.setBinding(creds.binding_id, this.opts.getCurrentUserId());
        this.opts.logger.info(`[rc.proxy] renderer credentials cached binding_id=${creds.binding_id}`);
        if (this.connection) {
            if (previousBindingId !== creds.binding_id) {
                this.opts.logger.info(`[rc.proxy] binding change old_binding_id=${previousBindingId ?? 'unknown'} new_binding_id=${creds.binding_id} action=restart_connection`);
                void this.startConnection(creds.binding_id);
            }
            else {
                this.opts.logger.info(`[rc.proxy] binding refresh old_binding_id=${previousBindingId} new_binding_id=${creds.binding_id} action=retry_connection`);
                // Live connection idling on backoff → jump straight to a fresh attempt.
                this.connection.retryNow();
            }
        }
    }
    /**
     * The renderer's `GET /binding` reported state=none — no mobile binding
     * owns this desktop. This is the ONLY disconnect trigger in the self-heal
     * design (§2): stop the WS, clear local binding, turn `unbound`. Every
     * other error keeps retrying forever.
     */
    onRendererBindingLost() {
        this.opts.logger.info('[rc.proxy] renderer reports binding lost (state=none); disconnecting');
        this.rendererCredentials = null;
        this.dataPlane?.upstream?.stop();
        if (this.connection) {
            this.connection.stop('server_initiated_unbind');
            this.connection = null;
        }
        this.stopPolling();
        this.opts.identity.clearBinding();
        this.setStatus({ phase: 'unbound' });
    }
    /**
     * The renderer has already issued the unbind HTTP call via its own axios
     * pipeline (which carries the matrix gateway signature material the main
     * process cannot produce — see pairing-client.ts header comments). The
     * main process only needs to drop its in-process state: stop the WS,
     * clear the cached renderer credentials and the local binding record,
     * and turn `unbound`. Do NOT call pairingClient.unbind() here — the
     * renderer already did, and re-issuing it from the main process would
     * race with the renderer's own call (and would also 401, see §4.2).
     *
     * This is the user-initiated "unbind phone" path: Settings → Connection
     * → Unbind button. The account-switch path (rc.ipc.ts
     * onUserInfoChanged) still uses disconnect({unbind:true}) because there
     * is no renderer to issue the HTTP call in that scenario.
     */
    onRendererUnbound() {
        this.opts.logger.info('[rc.proxy] renderer reports unbind done (HTTP unbind issued by renderer); clearing local state');
        this.rendererCredentials = null;
        this.dataPlane?.upstream?.stop();
        if (this.connection) {
            this.connection.stop('server_initiated_unbind');
            this.connection = null;
        }
        this.stopPolling();
        this.opts.identity.clearBinding();
        this.setStatus({ phase: 'unbound' });
    }
    /**
     * A local WS-routing setting changed. Keep the durable binding, but discard
     * the one-shot renderer ticket/endpoint and force the renderer to sign a
     * fresh bundle before the next WS attempt. With no active connection there
     * is no lifecycle to disrupt; the next normal connect reads the current
     * headers anyway.
     */
    onSwimLaneChanged() {
        const connection = this.connection;
        if (!connection)
            return;
        const bindingId = this.status.binding_id ?? this.opts.identity.getState().binding_id;
        this.rendererCredentials = null;
        this.dataPlane?.upstream?.stop();
        connection.stop('app_quit');
        this.connection = null;
        if (bindingId !== undefined) {
            this.setStatus({ phase: 'reconnecting', binding_id: bindingId });
        }
        this.opts.requestRendererRefresh?.();
    }
    onStatusChange(cb) {
        this.listeners.add(cb);
        return () => {
            this.listeners.delete(cb);
        };
    }
    /**
     * Check binding status via GET /binding WITHOUT initiating pairing.
     * Updates internal status and returns it. Used on page enter to decide
     * whether to show Connect or Settings.
     *
     * NOTE: Binding state is now owned by the renderer (axios → archon_biz with
     * the renderer's token). The main process must NOT poll /binding itself —
     * its token (storage.ipc) and the renderer's token (localStorage) are
     * independently refreshed and can drift out of sync, which surfaces as
     * `401 token_expired` log spam from this method. If a bound state is
     * detected here (e.g. legacy IPC path), we still record the binding so the
     * WS layer can connect; otherwise we just report `idle`.
     */
    async checkBinding() {
        try {
            this.opts.identity.ensure();
            const info = await this.opts.pairingClient.getBinding();
            this.opts.logger.info(`[rc.proxy] checkBinding: ${describeBindingForLog(info)}`);
            if (info.state === 'bound' && info.binding_id !== undefined) {
                this.opts.identity.setBinding(info.binding_id, this.opts.getCurrentUserId());
                this.setStatus({ phase: 'connected', binding_id: info.binding_id });
            }
            else {
                // pairing/none → do not start the 1Hz poll from the main process; the
                // renderer drives the pairing flow and pushes state via
                // onStatusChanged when it's ready to connect.
                this.setStatus({ phase: 'idle' });
            }
        }
        catch (err) {
            const { code, message } = toErrorInfo(err);
            this.opts.logger.warn(`[rc.proxy] checkBinding failed: ${code} ${message}`);
            this.setStatus({ phase: 'idle' });
        }
        return this.getStatus();
    }
    /**
     * Request a fresh pairing code via POST /pairing/code and start polling.
     * Does NOT check binding first — caller should have checked via checkBinding().
     */
    async requestPairingCode() {
        try {
            this.opts.identity.ensure();
            await this.issuePairingCode();
            this.startPolling();
        }
        catch (err) {
            const { code, message } = toErrorInfo(err);
            this.opts.logger.error(`[rc.proxy] requestPairingCode failed: ${code} ${message}`);
            this.setStatus({ phase: 'error', last_error: { code, message } });
        }
        return this.getStatus();
    }
    /**
     * Begin establishing the bridge. Idempotent: already connected returns the
     * current snapshot; a connect already in flight is joined, not restarted.
     * Resolves at the first stable milestone (pairing code issued / connected /
     * reconnecting / error) — later transitions stream via onStatusChange.
     */
    connect() {
        if (this.status.phase === 'connected' || this.status.phase === 'pairing') {
            return Promise.resolve(this.toConnectResult());
        }
        if (this.connection &&
            (this.status.phase === 'connecting' || this.status.phase === 'reconnecting')) {
            // A live connection attempt already owns the lifecycle.
            return Promise.resolve(this.toConnectResult());
        }
        if (this.connectInFlight)
            return this.connectInFlight;
        this.opts.logger.info('[rc.proxy] connect() invoked');
        this.connectInFlight = this.doConnect().finally(() => {
            this.connectInFlight = null;
        });
        return this.connectInFlight;
    }
    /**
     * Tear down. Default keeps the binding (reconnectable); {unbind:true} also
     * deletes it server-side and clears local binding state. A failed server
     * unbind keeps the local identity so callers can retry and must never report
     * a stale server-side binding as successfully removed.
     */
    async disconnect(opts = {}) {
        this.opts.logger.info(`[rc.proxy] disconnect() unbind=${opts.unbind === true}`);
        this.stopPolling();
        this.dataPlane?.upstream?.stop();
        if (this.connection) {
            this.connection.stop('app_quit');
            this.connection = null;
        }
        if (opts.unbind) {
            const bindingId = this.opts.identity.getState().binding_id;
            if (bindingId !== undefined) {
                try {
                    await this.opts.pairingClient.unbind(bindingId);
                    this.opts.logger.info(`[rc.proxy] unbind ok binding_id=${bindingId}`);
                }
                catch (err) {
                    const { code, message } = toErrorInfo(err);
                    this.opts.logger.error(`[rc.proxy] unbind binding_id=${bindingId} failed; preserving local binding for retry: ${code} ${message}`);
                    this.setStatus({ phase: 'error', binding_id: bindingId, last_error: { code, message } });
                    throw err;
                }
            }
            else {
                this.opts.logger.info('[rc.proxy] unbind requested but no local binding exists');
            }
            this.opts.identity.clearBinding();
            this.setStatus({ phase: 'unbound' });
            return;
        }
        this.setStatus({ phase: 'idle', binding_id: this.opts.identity.getState().binding_id });
    }
    async doConnect() {
        // T0: device_id must exist before any HTTP
        this.opts.identity.ensure();
        // Binding state is now owned by the renderer (axios → archon_biz with
        // the renderer's token). The main process no longer polls /binding —
        // using the storage.ipc token here surfaced spurious 401s and could
        // return stale state (token drift between renderer and main). The
        // renderer pushes `phase: 'bound' {binding_id, ticket, endpoint}` via
        // `RC_BINDING_READY` once the user finishes the pairing flow on the
        // phone, which lands in applyRendererCredentials().
        if (this.rendererCredentials) {
            const bindingId = this.rendererCredentials.bindingId;
            this.setStatus({ phase: 'connecting', binding_id: bindingId });
            return await this.startConnection(bindingId);
        }
        const status = this.getStatus();
        if (status.phase === 'connected' && status.binding_id !== undefined) {
            return await this.startConnection(status.binding_id);
        }
        this.opts.logger.info(`[rc.proxy] connect: no binding yet (phase=${status.phase}); renderer drives pairing`);
        return this.toConnectResult();
    }
    async issuePairingCode() {
        const result = await this.opts.pairingClient.createPairingCode();
        this.lastCodeIssueMs = Date.now();
        this.codeDeadlineMs = Date.now() + result.expires_in_s * 1000;
        this.opts.logger.info(`[rc.proxy] pairing code issued (expires_in_s=${result.expires_in_s})`);
        this.setStatus({
            phase: 'pairing',
            pairing_code: result.pairing_code,
            expires_in: result.expires_in_s,
        });
    }
    startPolling() {
        if (this.pollTimer)
            return;
        this.pollFailures = 0;
        this.pollTimer = setInterval(() => {
            void this.pollTick();
        }, this.pollIntervalMs);
    }
    stopPolling() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        this.pollBusy = false;
    }
    async pollTick() {
        if (this.pollBusy)
            return;
        this.pollBusy = true;
        try {
            const info = await this.opts.pairingClient.getBinding();
            this.pollFailures = 0;
            if (info.state === 'bound' && info.binding_id !== undefined) {
                this.stopPolling();
                this.opts.logger.info(`[rc.proxy] pairing confirmed: ${describeBindingForLog(info)}`);
                this.opts.identity.setBinding(info.binding_id, this.opts.getCurrentUserId());
                // Feed the freshly-signed ticket into the credential cache so the WS
                // layer can consume it (the provider never queries /binding itself).
                if (info.ticket && info.endpoint) {
                    this.rendererCredentials = {
                        bindingId: info.binding_id,
                        ticket: info.ticket,
                        endpoint: info.endpoint,
                        fetchedAtMs: Date.now(),
                    };
                }
                void this.startConnection(info.binding_id);
                return;
            }
            if (info.expires_at_ms !== undefined)
                this.codeDeadlineMs = info.expires_at_ms;
            const expired = this.codeDeadlineMs !== null && Date.now() >= this.codeDeadlineMs;
            if (info.state === 'none' || expired) {
                // Code expired (or server dropped it) → none → re-enter pairing flow
                // with a fresh code (plan §3 state machine).
                if (Date.now() - this.lastCodeIssueMs >= MIN_CODE_REISSUE_INTERVAL_MS) {
                    this.opts.logger.info('[rc.proxy] pairing code expired; issuing a fresh one');
                    await this.issuePairingCode();
                }
                return;
            }
            // Still pairing: refresh the countdown for the UI. Log at low frequency
            // only; the poll itself runs at 1Hz.
            const remaining = this.remainingSeconds();
            const now = Date.now();
            if (now - this.lastStillPairingLogMs >= STILL_PAIRING_LOG_INTERVAL_MS) {
                this.lastStillPairingLogMs = now;
                this.opts.logger.debug(`[rc.proxy] pairing still pending state=${info.state ?? 'unknown'} remaining_s=${remaining ?? 'unknown'}`);
            }
            if (remaining !== undefined) {
                this.setStatus({ ...this.status, phase: 'pairing', expires_in: remaining });
            }
        }
        catch (err) {
            const { code, message } = toErrorInfo(err);
            if (code === 'token_expired' || code === 'not_authenticated') {
                this.opts.logger.error(`[rc.proxy] pairing poll auth failure: ${code}`);
                this.stopPolling();
                this.setStatus({ phase: 'error', last_error: { code, message } });
                return;
            }
            this.pollFailures += 1;
            this.opts.logger.warn(`[rc.proxy] pairing poll failure ${this.pollFailures}/${MAX_CONSECUTIVE_POLL_FAILURES}: ${code}`);
            if (this.pollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
                this.stopPolling();
                this.setStatus({ phase: 'error', last_error: { code, message } });
            }
        }
        finally {
            this.pollBusy = false;
        }
    }
    /** Spin up the WS and resolve at its first settle (see connect() doc). */
    startConnection(bindingId) {
        this.connection?.stop('app_quit');
        this.setStatus({ phase: 'connecting', binding_id: bindingId });
        return new Promise((resolve) => {
            let settled = false;
            const settle = () => {
                if (settled)
                    return;
                settled = true;
                resolve(this.toConnectResult());
            };
            const credentials = createCredentialProvider(() => this.rendererCredentials);
            const connection = new RcConnection({
                credentials,
                clientVersion: this.opts.clientVersion,
                isRuntimeHealthy: this.opts.isRuntimeHealthy,
                logger: this.opts.logger,
                ...(this.dataPlane?.router
                    ? { commandRouter: this.dataPlane.router }
                    : this.opts.commandRouter
                        ? { commandRouter: this.opts.commandRouter }
                        : {}),
                ...(this.opts.getWebSocketHeaders
                    ? { getWebSocketHeaders: this.opts.getWebSocketHeaders }
                    : {}),
                ...(this.opts.wsFactory ? { wsFactory: this.opts.wsFactory } : {}),
                onEvent: (ev) => {
                    this.handleConnectionEvent(connection, ev, bindingId);
                    if (ev.kind === 'connected' ||
                        ev.kind === 'reconnecting' ||
                        ev.kind === 'need-credentials' ||
                        ev.kind === 'stopped') {
                        settle();
                    }
                },
            });
            this.connection = connection;
            connection.start();
        });
    }
    handleConnectionEvent(connection, ev, bindingId) {
        if (this.connection !== connection)
            return; // stale connection instance
        switch (ev.kind) {
            case 'connecting':
                if (this.status.phase !== 'reconnecting') {
                    this.setStatus({ phase: 'connecting', binding_id: bindingId });
                }
                return;
            case 'connected':
                if (this.dataPlane)
                    this.dataPlane.activeStreamScope = ev.connectionId;
                // The upstream stays subscribed across transient reconnects so the
                // three notification-trigger events can be buffered in memory.
                this.dataPlane?.upstream?.start();
                this.dataPlane?.upstream?.onConnected();
                // Burn-after-use: the one-shot ticket has now been consumed by a
                // successful handshake. Drop it so any later reconnect goes stale →
                // need-credentials → renderer re-sign, never replaying a dead ticket
                // (which the gateway rejects as ticket_invalid — design §4.5).
                this.rendererCredentials = null;
                this.setStatus({ phase: 'connected', binding_id: bindingId });
                return;
            case 'reconnecting':
                // WS down → abort only the pumps owned by that gateway connection.
                this.abortActiveStreamScope('ws-reconnecting');
                this.setStatus({ phase: 'reconnecting', binding_id: bindingId });
                return;
            case 'need-credentials':
                // The provider had no fresh ticket. Ask the renderer to re-sign; the
                // connection has already armed a backoff re-attempt, so a slow/absent
                // renderer never wedges the loop (design §4.3).
                this.abortActiveStreamScope('ws-need-credentials');
                this.opts.logger.info('[rc.proxy] need-credentials → requesting renderer refresh');
                this.opts.requestRendererRefresh?.();
                this.setStatus({ phase: 'reconnecting', binding_id: bindingId });
                return;
            case 'replay-overflow':
                // IDL: empty payload — replay unrecoverable. Wave 1: recorded only.
                // Wave 2+: trigger the phone's full snapshot refetch.
                this.opts.logger.warn('[rc.proxy] replay overflow — full snapshot refetch required');
                return;
            case 'stopped':
                this.abortActiveStreamScope('ws-stopped');
                this.dataPlane?.upstream?.stop();
                this.handleConnectionStopped(ev, bindingId);
                break;
            default:
                break;
        }
    }
    abortActiveStreamScope(cause) {
        const scope = this.dataPlane?.activeStreamScope;
        if (!scope)
            return;
        this.dataPlane?.pump?.abortAll(cause, scope);
        if (this.dataPlane?.activeStreamScope === scope) {
            this.dataPlane.activeStreamScope = undefined;
        }
    }
    handleConnectionStopped(ev, bindingId) {
        switch (ev.cause) {
            case 'requested':
                return; // disconnect() sets the final phase itself
            case 'superseded':
                // Quiet exit; binding stays valid for a later connect().
                this.connection = null;
                this.setStatus({ phase: 'idle', binding_id: bindingId });
                return;
            case 'credentials': {
                // Gateway rejected the ticket (auth_expired / ticket_invalid). The
                // ticket was one-shot and is now spent, so the cached bundle is dead:
                // drop it and drive the renderer re-sign loop instead of retrying the
                // same dead ticket or dead-ending in `error`. Never a disconnect —
                // the only disconnect exit is renderer state=none (design §4.5).
                this.rendererCredentials = null;
                this.opts.logger.warn(`[rc.proxy] ${ev.reason ?? 'credentials rejected'}; requesting renderer refresh + retrying`);
                this.setStatus({ phase: 'reconnecting', binding_id: bindingId });
                this.opts.requestRendererRefresh?.();
                this.connection?.start();
                return;
            }
            case 'server-unbind':
                // IDL DisconnectCode.SERVER_INITIATED_UNBIND → desktop turns Unbound.
                this.connection = null;
                this.opts.identity.clearBinding();
                this.setStatus({ phase: 'unbound' });
                break;
            default:
                break;
        }
    }
    remainingSeconds() {
        if (this.codeDeadlineMs === null)
            return undefined;
        return Math.max(0, Math.round((this.codeDeadlineMs - Date.now()) / 1000));
    }
    toConnectResult() {
        const result = { phase: this.status.phase };
        if (this.status.binding_id !== undefined)
            result.binding_id = this.status.binding_id;
        if (this.status.pairing_code !== undefined)
            result.pairing_code = this.status.pairing_code;
        if (this.status.expires_in !== undefined)
            result.expires_in = this.status.expires_in;
        if (this.status.last_error !== undefined)
            result.last_error = { ...this.status.last_error };
        return result;
    }
    setStatus(next) {
        this.status = next;
        const snapshot = this.getStatus();
        for (const cb of this.listeners) {
            try {
                cb(snapshot);
            }
            catch (err) {
                this.opts.logger.warn(`[rc.proxy] status listener threw: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }
}
function toErrorInfo(err) {
    if (err instanceof PairingClientError)
        return { code: err.code, message: err.message };
    if (err instanceof Error)
        return { code: 'internal_error', message: err.message };
    return { code: 'internal_error', message: String(err) };
}
export { createAttachmentFetcher } from './attachment-fetch.js';
export { DeviceIdentityStore } from './device-identity.js';
export { PairingClient } from './pairing-client.js';
export { describeBindingForLog, deviceIdForLog, hashTail6, redactWsUrl, } from './audit-redaction.js';
//# sourceMappingURL=index.js.map