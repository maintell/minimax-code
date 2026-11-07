/**
 * Migration copy (MR1) of v1 `channels/adapters/wechat/sdk/ilink-monitor.ts`.
 */
/**
 * iLink Bot SDK — Message monitor (long-polling loop).
 *
 * EventEmitter-based message listener with:
 *   - Long-poll getUpdates loop
 *   - Automatic reconnection with exponential backoff
 *   - Graceful shutdown via AbortController
 *   - get_updates_buf state management
 */
import { EventEmitter } from 'node:events';
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
/** Session expired error code from the server. */
const SESSION_EXPIRED_ERRCODE = -14;
// ---------------------------------------------------------------------------
// ILinkMonitor
// ---------------------------------------------------------------------------
export class ILinkMonitor extends EventEmitter {
    client;
    getUpdatesBuf;
    abortController;
    externalAbortSignal;
    allowFrom;
    running = false;
    onSessionExpired;
    sessionExpiredPauseMs;
    botId;
    /** Server-suggested timeout for next long-poll; undefined = use client default. */
    nextPollTimeoutMs;
    /** Last emitted `status` — lets a success after `reconnecting` announce recovery. */
    lastStatus;
    constructor(opts) {
        super();
        this.client = opts.client;
        this.getUpdatesBuf = opts.getUpdatesBuf ?? '';
        this.abortController = new AbortController(); // replaced on each start()
        this.externalAbortSignal = opts.abortSignal;
        this.allowFrom = new Set(opts.allowFrom ?? []);
        this.onSessionExpired = opts.onSessionExpired;
        this.sessionExpiredPauseMs = opts.sessionExpiredPauseMs ?? 60 * 60_000;
        this.botId = opts.botId;
    }
    /** Current get_updates_buf value (for persistence). */
    getState() {
        return this.getUpdatesBuf;
    }
    /** Whether the monitor loop is currently running. */
    isRunning() {
        return this.running;
    }
    /** Start the long-polling loop. Returns when stopped or aborted. */
    async start() {
        if (this.running)
            return;
        this.running = true;
        // Create a fresh AbortController so stop() → start() works correctly.
        this.abortController = new AbortController();
        // Listen for external abort
        if (this.externalAbortSignal) {
            this.externalAbortSignal.addEventListener('abort', () => this.stop(), { once: true });
        }
        this.emitStatus('polling');
        this.emit('connected');
        let consecutiveFailures = 0;
        while (this.running && !this.abortController.signal.aborted) {
            const outcome = await this.pollOnce();
            if (outcome === 'stop')
                break;
            if (outcome === 'ok') {
                consecutiveFailures = 0;
                continue;
            }
            // outcome === 'failed' — shared backoff ladder for API and transport errors.
            consecutiveFailures++;
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                this.emitStatus('reconnecting');
                consecutiveFailures = 0;
                await this.sleep(BACKOFF_DELAY_MS);
            }
            else {
                await this.sleep(RETRY_DELAY_MS);
            }
        }
        this.running = false;
        this.emitStatus('stopped');
        this.emit('disconnected', 'stopped');
    }
    /**
     * One getUpdates round. Returns 'ok' (reset failure counter), 'failed'
     * (caller applies the shared backoff ladder) or 'stop' (terminal:
     * session_expired without retry, or an abort).
     */
    async pollOnce() {
        // Set once getUpdates settled: anything thrown after it comes from a
        // listener of this round, not from the request, so it is no verdict.
        let answered = false;
        try {
            const resp = await this.client.getUpdates(this.getUpdatesBuf, this.nextPollTimeoutMs);
            answered = true;
            const isApiError = (resp.ret !== undefined && resp.ret !== 0) ||
                (resp.errcode !== undefined && resp.errcode !== 0);
            if (isApiError)
                return this.handleApiError(resp);
            this.adoptPollState(resp);
            this.onPollSucceeded();
            this.emitFilteredMessages(resp.msgs ?? []);
            return 'ok';
        }
        catch (err) {
            if (this.abortController.signal.aborted)
                return 'stop';
            const error = err instanceof Error ? err : new Error(String(err));
            if (!answered)
                this.emit('poll', { outcome: 'request_failed', error });
            this.emit('error', error);
            return 'failed';
        }
    }
    /**
     * The server answered with ret / errcode 0. After a failure streak the
     * loop announced `reconnecting` but nothing ever announced the way back,
     * so the status stayed `reconnecting` for the rest of the loop; announce
     * `polling` again on the first success.
     */
    onPollSucceeded() {
        this.emit('poll', { outcome: 'ok' });
        if (this.lastStatus === 'reconnecting')
            this.emitStatus('polling');
    }
    /**
     * A `session_expired` (-14) means the iLink bot login session is dead —
     * retrying the SAME token just yields -14 again, so the historical
     * "sleep 1h then retry" path left the bot dark for an hour and then
     * dead-looped. Default to STOPPING the loop and surfacing `disconnected`
     * so the channel status flips to needs-reconnect; recovery happens when
     * the user re-scans / reopens the bind panel
     * (adapter.ensureMonitorRunning restarts with fresh credentials). A
     * caller may still inject `onSessionExpired` to opt into a retry.
     */
    async handleApiError(resp) {
        const isSessionExpired = resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE;
        if (isSessionExpired) {
            this.emit('poll', { outcome: 'session_expired' });
            this.emitStatus('session_expired');
            const shouldRetry = this.onSessionExpired ? await this.onSessionExpired() : false;
            if (!shouldRetry) {
                this.emit('disconnected', 'session_expired');
                return 'stop';
            }
            await this.sleep(this.sessionExpiredPauseMs);
            return 'ok';
        }
        this.emit('poll', { outcome: 'api_error' });
        this.emit('error', new Error(`getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ''}`));
        return 'failed';
    }
    /** Adopt the server-suggested long-poll timeout and updates cursor. */
    adoptPollState(resp) {
        if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
            this.nextPollTimeoutMs = resp.longpolling_timeout_ms;
        }
        if (resp.get_updates_buf) {
            this.getUpdatesBuf = resp.get_updates_buf;
        }
    }
    /** Emit inbound messages, dropping the bot's own and non-allowlisted senders. */
    emitFilteredMessages(msgs) {
        for (const msg of msgs) {
            // Filter out bot's own messages to prevent loops.
            if (this.botId && msg.from_user_id === this.botId)
                continue;
            if (this.allowFrom.size > 0 && msg.from_user_id && !this.allowFrom.has(msg.from_user_id)) {
                continue;
            }
            this.emit('message', msg);
        }
    }
    /** Stop the monitor loop. */
    stop() {
        this.running = false;
        this.abortController.abort();
    }
    /** Add a user ID to the allowFrom filter. */
    addAllowedUser(userId) {
        this.allowFrom.add(userId);
    }
    /** Remove a user ID from the allowFrom filter. */
    removeAllowedUser(userId) {
        this.allowFrom.delete(userId);
    }
    /** Set the bot's own ID to filter out self-messages. */
    setBotId(botId) {
        this.botId = botId;
    }
    // -------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------
    emitStatus(status) {
        this.lastStatus = status;
        this.emit('status', status);
    }
    sleep(ms) {
        return new Promise((resolve) => {
            const timer = setTimeout(resolve, ms);
            const onAbort = () => {
                clearTimeout(timer);
                resolve();
            };
            this.abortController.signal.addEventListener('abort', onAbort, { once: true });
        });
    }
}
//# sourceMappingURL=ilink-monitor.js.map