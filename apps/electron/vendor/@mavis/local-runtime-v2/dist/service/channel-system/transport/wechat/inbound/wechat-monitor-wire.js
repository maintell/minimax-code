/**
 * Migration copy (MR1) of v1 `channels/adapters/wechat/wechat-monitor-wire.ts`.
 */
/**
 * WeChat iLink monitor wire — the seam that turns a started
 * {@link WeChatMonitorHandle} into `runner.dispatchInbound` calls.
 *
 * History context: before the imGateway split, this glue lived in
 * `apps/electron/.../platforms/wechat.ts` (`WeChatPlatform.handleMessageEvent`),
 * which started an `ILinkMonitor`, subscribed to `'message'`, parsed the
 * `WeixinMessage` into the gateway envelope, and emitted it back to the
 * daemon via the `imGateway → im-runtime-bridge → runner.dispatchInbound`
 * chain. The imGateway path is gone; we now do the equivalent work inside
 * the WeChat platform adapter so a desktop bind immediately starts pulling
 * messages without any daemon / gateway process in between.
 *
 * Split out of `wechat-adapter.ts` to keep that file under the per-file
 * layout budget — the wire owns the long-poll lifecycle and the
 * `WeixinMessage → ChannelInboundDispatchInput` translation, the adapter
 * just owns `start()` / `stop()` of an instance of this class on bind /
 * unbind.
 *
 * Filtering rules mirror the historical platform code:
 *   - drop messages whose `message_type !== MessageType.USER` (bot's own
 *     outbound round-trips through the monitor, must not loop back),
 *   - drop messages older than 10 minutes (`STALE_THRESHOLD_MS`) — covers
 *     desktop restart where the SDK replays buffered updates from before
 *     the user opened the app,
 *   - drop messages from the bot's own `ilinkBotId` (the SDK's `botId`
 *     filter already does this server-side, but defence in depth).
 *
 * Concurrency: `start()` is idempotent (no-op when already running), and
 * `stop()` always nullifies the handle so a later `start()` re-creates
 * one fresh. Listeners are attached/detached symmetrically so a hot
 * unbind+rebind never leaks a stale subscription.
 */
import { detach } from '../../../settle.js';
import { MessageType } from '../sdk/ilink-types.js';
import { LocalWeChatChannelStore } from '../wechat-store.js';
import { parseLocalWeChatEvent } from './wechat-events.js';
import { resolveWeChatAttachments, } from './wechat-attachment-support.js';
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
/** Dropping messages older than this is safe — agent context has rotated. */
const STALE_THRESHOLD_MS = 10 * 60 * 1000;
export class LocalWeChatMonitorWire {
    options;
    nowMs;
    monitor = null;
    /** botToken the live monitor was started with — detects rebind (token change). */
    startedToken = null;
    /** Last status emitted by the monitor — detects a dead (expired/stopped) loop. */
    lastStatus = null;
    messageListener = null;
    errorListener = null;
    statusListener = null;
    disconnectedListener = null;
    constructor(options) {
        this.options = options;
        this.nowMs = options.nowMs ?? (() => Date.now());
    }
    /**
     * Start the iLink long-poll for the bound agent. Returns as soon as the
     * loop is running: the real SDK's `start()` resolves only after `stop()`,
     * so awaiting it would hold startup readiness forever. Background loop
     * failures remain observed and release this wire's current monitor.
     */
    async start() {
        if (this.monitor)
            return;
        const { agentName, sdk } = this.options;
        if (!sdk.createMonitor) {
            logger.warn({ reason: 'missing_create_monitor', agentName, clientName: this.options.clientName }, 'WeChat monitor inbound disabled');
            return;
        }
        const record = await this.readStartableRecord();
        if (!record)
            return;
        logger.info({
            agentName,
            clientName: this.options.clientName,
            hasCursor: Boolean(record.getUpdatesBuf),
        }, 'WeChat monitor start attempt');
        const client = sdk.createClient({
            token: record.botToken,
            ...(record.baseUrl ? { baseUrl: record.baseUrl } : {}),
        });
        this.startedToken = record.botToken;
        this.lastStatus = null;
        const createParams = { client };
        if (record.ilinkBotId)
            createParams.botId = record.ilinkBotId;
        // Resume from the persisted cursor so a desktop restart picks up
        // exactly where the previous monitor left off. Empty cursor on first
        // start = SDK default ("start from now"). C4 persists `getUpdatesBuf`
        // on every `disconnected` event.
        if (record.getUpdatesBuf)
            createParams.getUpdatesBuf = record.getUpdatesBuf;
        const monitor = sdk.createMonitor(createParams);
        this.attachListeners(monitor);
        this.monitor = monitor;
        try {
            const loop = monitor.start();
            if (!monitor.isRunning()) {
                // SDK startup failures reject before entering the long-poll loop, so
                // preserve their original error for restore/bind callers.
                await loop;
                if (!monitor.isRunning()) {
                    logger.warn({ agentName, clientName: this.options.clientName }, 'WeChat monitor did not enter running state');
                    this.clearCurrentMonitor(monitor);
                }
                return;
            }
            detach(this.watchMonitorLoop(loop, monitor));
            logger.info({ agentName, clientName: this.options.clientName }, 'WeChat monitor started');
        }
        catch (err) {
            logger.error({ err, agentName, clientName: this.options.clientName }, 'WeChat monitor start failed');
            this.clearCurrentMonitor(monitor);
            throw err;
        }
    }
    /**
     * Stop the long-poll and release the monitor. Safe to call when not
     * running (no-op). Listeners are detached before nullifying the handle
     * so a re-`start()` builds a clean subscription set.
     */
    stop() {
        if (!this.monitor)
            return;
        const { agentName, clientName } = this.options;
        logger.info({ agentName, clientName, reason: 'adapter-stop' }, 'WeChat monitor stop requested (intentional)');
        const monitor = this.monitor;
        try {
            monitor.stop();
        }
        catch (err) {
            logger.error({ err, agentName, clientName }, 'WeChat monitor stop failed');
        }
        this.clearCurrentMonitor(monitor);
    }
    /** Current `get_updates_buf` cursor (for persistence in C4). */
    getCursor() {
        return this.monitor?.getState() ?? '';
    }
    isRunning() {
        return this.monitor?.isRunning() === true;
    }
    /**
     * Whether a {@link restart} is required to get a healthy monitor for
     * `currentToken`. True when there is no monitor, the loop is dead
     * (`session_expired` / `stopped`), or the binding token changed since the
     * monitor started (rebind). False when a monitor is alive on the same
     * token — callers must no-op then to avoid thrashing the long-poll on every
     * status poll.
     */
    needsRestart(currentToken) {
        if (!this.monitor)
            return true;
        if (this.lastStatus === 'session_expired' || this.lastStatus === 'stopped')
            return true;
        if (this.startedToken !== currentToken)
            return true;
        return false;
    }
    /** Last status the monitor emitted (`null` before the first start). */
    liveStatus() {
        return this.lastStatus;
    }
    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------
    /** Monitor start precondition: a live (non-QR-pending) bot token. */
    async readStartableRecord() {
        const { agentName, store } = this.options;
        const record = await store.get(agentName);
        if (!record?.botToken || record.botToken.startsWith('pending:')) {
            logger.warn({
                agentName,
                clientName: this.options.clientName,
                reason: 'missing_usable_binding',
                hasRecord: Boolean(record),
                botTokenPending: Boolean(record?.botToken?.startsWith('pending:')),
            }, 'WeChat monitor not started');
            return undefined;
        }
        return record;
    }
    attachListeners(monitor) {
        const { agentName, clientName } = this.options;
        this.messageListener = (msg) => {
            detach(this.handleMessageLogged(msg, agentName, clientName));
        };
        this.errorListener = (err) => {
            logger.error({ err, agentName, clientName }, 'WeChat monitor error event');
        };
        this.statusListener = (status) => {
            const prev = this.lastStatus;
            this.lastStatus = status;
            logger.info({ status, prevStatus: prev, agentName, clientName }, 'WeChat monitor status changed');
        };
        this.disconnectedListener = (reason) => {
            logger.info({ reason, agentName, clientName, lastStatus: this.lastStatus }, 'WeChat monitor disconnected');
            // Persist the cursor on every disconnect so the next start() (or a
            // desktop restart) resumes after the last delivered update. Fire-
            // and-forget; failure to persist degrades to "may replay a few
            // messages on resume", which is acceptable.
            const cursor = monitor.getState();
            detach(this.persistCursorLogged(cursor));
        };
        monitor.on('message', this.messageListener);
        monitor.on('error', this.errorListener);
        monitor.on('status', this.statusListener);
        monitor.on('disconnected', this.disconnectedListener);
    }
    detachListeners() {
        if (!this.monitor) {
            this.messageListener = null;
            this.errorListener = null;
            this.statusListener = null;
            this.disconnectedListener = null;
            return;
        }
        if (this.messageListener)
            this.monitor.off('message', this.messageListener);
        if (this.errorListener)
            this.monitor.off('error', this.errorListener);
        if (this.statusListener)
            this.monitor.off('status', this.statusListener);
        if (this.disconnectedListener)
            this.monitor.off('disconnected', this.disconnectedListener);
        this.messageListener = null;
        this.errorListener = null;
        this.statusListener = null;
        this.disconnectedListener = null;
    }
    /**
     * Detached supervision of the monitor loop: a clean exit clears the stale
     * handle; a crash logs and clears so the next start() can rebuild.
     */
    async watchMonitorLoop(loop, monitor) {
        try {
            await loop;
            if (this.monitor === monitor && !monitor.isRunning()) {
                this.clearCurrentMonitor(monitor);
            }
        }
        catch (err) {
            if (this.monitor !== monitor)
                return;
            logger.error({ err, agentName: this.options.agentName, clientName: this.options.clientName }, 'WeChat monitor loop failed');
            this.clearCurrentMonitor(monitor);
        }
    }
    clearCurrentMonitor(monitor) {
        if (this.monitor !== monitor)
            return;
        this.detachListeners();
        this.monitor = null;
        this.startedToken = null;
        this.lastStatus = null;
    }
    /**
     * Translate one `WeixinMessage` into a dispatch on the channel runner.
     * Pure-async — never throws into the EventEmitter listener; `start()`'s
     * `messageListener` wrapper catches and logs anything that escapes.
     */
    /** Detached message dispatch; failures log and never kill the monitor. */
    async handleMessageLogged(msg, agentName, clientName) {
        try {
            await this.handleMessage(msg);
        }
        catch (err) {
            logger.error({ err, agentName, clientName }, 'WeChat monitor message handler failed');
        }
    }
    /**
     * Fire-and-forget cursor persist; failure degrades to "may replay a few
     * messages on resume", which is acceptable.
     */
    async persistCursorLogged(cursor) {
        try {
            await this.options.store.setGetUpdatesBuf(this.options.agentName, cursor);
        }
        catch (err) {
            logger.error({ err, agentName: this.options.agentName }, 'WeChat monitor cursor persist failed');
        }
    }
    async handleMessage(msg) {
        if (this.shouldDropMessage(msg))
            return;
        const parsed = await this.parseMonitorMessage(msg);
        if (!parsed)
            return;
        // iLink REQUIRES the inbound message's `context_token` to be echoed back
        // on every outbound (the bot can only reply within an established
        // context). Inject it into the LocalChannelContext so the reply path
        // (LocalWeChatChannelAdapter.sendMessage -> readContextTokenFromCtx)
        // can pick it up. Without this, the adapter sends contextToken='' and
        // iLink silently drops the reply -- the symptom is "agent receives,
        // user gets nothing back".
        const ctxWithToken = {
            ...parsed.envelope.ctx,
            ...(msg.context_token ? { contextToken: msg.context_token } : {}),
        };
        if (msg.context_token && this.options.onContextToken) {
            try {
                this.options.onContextToken(parsed.envelope.ctx.chatId, msg.context_token);
            }
            catch {
                // Best-effort cache hook; never abort dispatch on observer failure.
            }
        }
        const record = await this.options.store.get(this.options.agentName);
        const { envelope: parsedEnvelope, body } = parsed;
        await this.dispatchMonitorEnvelope({ msg, body, parsed: parsedEnvelope, ctxWithToken, record });
    }
    /** Drop non-user and stale (delayed long-poll replay) messages, logged. */
    shouldDropMessage(msg) {
        if (!msg)
            return true;
        if (msg.message_type !== MessageType.USER)
            return true; // bot's own / system
        if (msg.create_time_ms && this.nowMs() - msg.create_time_ms > STALE_THRESHOLD_MS) {
            logger.info({
                messageId: msg.message_id ?? null,
                ageSeconds: Math.round((this.nowMs() - msg.create_time_ms) / 1000),
            }, 'WeChat monitor stale message dropped');
            return true;
        }
        return false;
    }
    /**
     * `parseLocalWeChatEvent` accepts a `{ message: WeixinMessage, agentName }`
     * body shape — the `normalizeWeChatMessageEvent` helper walks the
     * `message`/`msg` keys and extracts `chatId`, `senderId`, `text`,
     * `attachmentRefs`. Pass `agentName` so the resolved `clientName` matches
     * the binding (`wechat:<agent>`), not the package-wide default. Pass the
     * bound `botName` so group `@bot` mention detection + mention stripping
     * work (group slash commands are otherwise dropped by the mention policy).
     */
    async parseMonitorMessage(msg) {
        const boundRecord = await this.options.store.get(this.options.agentName);
        const body = {
            // WeixinMessage is a plain JSON record; spread-compatible view for the
            // shared event parser without casting through `unknown`.
            message: msg,
            agentName: this.options.agentName,
            ...(boundRecord?.botName ? { botName: boundRecord.botName } : {}),
        };
        const parsed = parseLocalWeChatEvent(body, this.options.agentName);
        if ('error' in parsed)
            return undefined;
        return { envelope: parsed, body };
    }
    async dispatchMonitorEnvelope(input) {
        const { msg, body, parsed, ctxWithToken, record } = input;
        // Diagnostic: surface every USER message hitting the wire so we know
        // whether image / voice payloads even reach monitor → adapter. Logs
        // only counts and id, never bytes / context_token / aes keys.
        logger.info({
            messageId: msg.message_id ?? null,
            attachmentRefs: parsed.attachmentRefs.length,
            textLength: parsed.text.length,
        }, 'WeChat monitor inbound message received');
        const attachments = await resolveWeChatAttachments(parsed.attachmentRefs, {
            messageId: parsed.eventId ?? '',
            contextToken: msg.context_token,
            botToken: record?.botToken,
            baseUrl: record?.baseUrl,
            sessionId: parsed.eventId ?? '',
            clientName: parsed.ctx.clientName,
            downloader: this.options.downloader,
        });
        try {
            await this.options.runner.dispatchInbound({
                ctx: ctxWithToken,
                text: parsed.text,
                ...(attachments.length > 0 ? { attachments } : {}),
                ...(parsed.eventId ? { eventId: parsed.eventId } : {}),
                // Forward the raw WeChat event body so the runner's permission
                // interception can reach `LocalWeChatChannelAdapter.parsePermissionReply`.
                // WeChat's permission reply is an ordinary text message (`/allow` etc.),
                // and the permission path only receives `raw` (never `text`), so without
                // this the three slash commands could never be decoded. Harmless to the
                // other paths: `handleInbound` ignores `raw`, and WeChat's
                // `tryHandleQuestionnaireReply` reads `text`, not `raw`.
                raw: body,
            });
        }
        catch (err) {
            logger.error({ err, messageId: msg.message_id ?? null }, 'WeChat monitor dispatch failed');
        }
    }
}
//# sourceMappingURL=wechat-monitor-wire.js.map