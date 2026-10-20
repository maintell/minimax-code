/**
 * Migration copy (MR1) of v1 `channels/adapters/telegram/telegram-poll-wire.ts`.
 */
/**
 * Telegram poll wire — the seam that turns started {@link TelegramPoller}
 * updates into `dispatchInbound` calls.
 *
 * Split out of `telegram-adapter.ts` to stay under the per-file layout
 * budget. The wire owns the poller lifecycle (start/stop/restart) and the
 * `Update → ChannelInboundDispatchInput` translation; the adapter just
 * `attach()`es a wire on bind and `detach()`es on unbind/shutdown.
 *
 * Filtering rules:
 *   - `callback_query` updates are NOT forwarded as plain inbound — the
 *     questionnaire / permission reply hooks own them. `parseLocalTelegramUpdate`
 *     rejects them outright, so forwarding here would surface as noise.
 *   - Any other update kind that `parseLocalTelegramUpdate` rejects is
 *     silently dropped (best-effort: the SDK keeps advancing the offset
 *     so a poison update does not freeze the loop).
 */
import { detach } from '../../settle.js';
import { parseLocalTelegramUpdate } from './telegram-events.js';
import { TelegramPoller, } from './telegram-poller.js';
import { ChannelTransportStatusTracker, } from '../../ingress/channel-transport-status.js';
import { downloadAttachmentsForUnifiedInbound, ensureUnifiedInboundText, } from './telegram-adapter-shared.js';
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
/**
 * How long a 409 keeps the channel on `error` / `poll_conflict` although
 * polls succeed in between. Telegram serves one getUpdates per token at a
 * time: with a second consumer (another client, a stale long-poll, a
 * webhook) both sides get terminated in turn and each still wins some
 * rounds, so a single success proves nothing — messages keep being split.
 * Only 90 s without a new 409 count as resolved.
 */
const POLL_CONFLICT_HOLD_MS = 90_000;
export class LocalTelegramPollWire {
    poller = null;
    options;
    nowMs;
    /** Live receive-channel state (see `channel-transport-status.ts`); held after the poller stops. */
    transport;
    /** Time of the latest 409 since the current start; drives the hold window. */
    lastConflictAtMs;
    constructor(options) {
        this.options = options;
        this.nowMs = options.nowMs ?? (() => Date.now());
        this.transport = new ChannelTransportStatusTracker({
            platform: 'telegram',
            agentName: options.defaultAgentName,
            clientName: options.clientName,
        });
    }
    start() {
        if (this.poller?.isRunning())
            return;
        const agentName = this.options.defaultAgentName;
        const clientName = this.options.clientName;
        logger.info({ agentName, clientName }, 'Telegram poll wire start');
        const pollerOptions = { botToken: this.options.botToken };
        if (this.options.fetcher)
            pollerOptions.fetcher = this.options.fetcher;
        if (this.options.sleep)
            pollerOptions.sleep = this.options.sleep;
        const poller = new TelegramPoller(pollerOptions);
        poller.on('update', (update) => {
            detach(this.handleUpdateLogged(update, agentName, clientName));
        });
        poller.on('error', (err) => {
            logger.error({ err, kind: err.kind, agentName, clientName }, 'Telegram poller error event');
        });
        poller.on('status', (status) => {
            logger.info({ status, agentName, clientName }, 'Telegram poller status changed');
        });
        poller.on('poll', (result) => {
            // A stopped poller can still finish an in-flight round; only the
            // current poller may move the state.
            if (this.poller === poller) {
                this.onPollResult(result);
                return;
            }
            // Logged so a dropped verdict (e.g. a late 401 after a rebind) is
            // visible. Fixed fields only — never the request URL, which carries
            // the bot token, nor the platform's text. At most once per stop: the
            // old loop exits after its in-flight round.
            logger.info({ agentName, clientName, outcome: result.outcome, reason: 'poller_not_current' }, 'Telegram poll verdict ignored: poller no longer current');
        });
        this.poller = poller;
        // A new start forgets the previous verdict (a held `token_invalid`
        // included) and the conflict window.
        this.lastConflictAtMs = undefined;
        this.transport.toConnecting('start_requested');
        poller.start();
    }
    stop() {
        // Our own stop turns the channel off; nothing it held is a failure now.
        this.transport.toIdle('stop_requested');
        if (!this.poller)
            return;
        const agentName = this.options.defaultAgentName;
        const clientName = this.options.clientName;
        logger.info({ agentName, clientName, wasRunning: this.poller.isRunning() }, 'Telegram poll wire stop');
        this.poller.stop();
        this.poller = null;
    }
    isRunning() {
        return this.poller?.isRunning() === true;
    }
    /** Live receive-channel state; held after the poller stops (401, crash) until the next start. */
    transportStatus() {
        return this.transport.snapshot();
    }
    /**
     * One getUpdates verdict → receive-channel state. Only an answered round
     * counts as `connected`; the poller's `status: 'polling'` fires before
     * every request.
     */
    onPollResult(result) {
        switch (result.outcome) {
            case 'ok':
                this.onPollSucceeded();
                break;
            case 'conflict':
                this.lastConflictAtMs = this.nowMs();
                this.transport.toError('poll_conflict', 'poll_conflict');
                break;
            case 'token_invalid':
                // The poller stops for good; the verdict is held until the next start.
                this.transport.toError('token_rejected', 'token_invalid');
                break;
            case 'rate_limited':
                // Our own polling is throttled; that says nothing about the channel.
                break;
            case 'http_error':
                this.transport.toError('poll_http_error', 'http_error', result.httpStatus);
                break;
            case 'network_error':
                this.transport.toError('poll_request_failed', result.timeout ? 'network_timeout' : 'network_error');
                break;
            case 'crashed':
                this.transport.toError('loop_crashed', 'unknown');
                break;
        }
    }
    onPollSucceeded() {
        const lastConflictAtMs = this.lastConflictAtMs;
        if (lastConflictAtMs !== undefined && this.nowMs() - lastConflictAtMs < POLL_CONFLICT_HOLD_MS) {
            // Inside the hold window a success is not proof the other consumer is
            // gone (see POLL_CONFLICT_HOLD_MS); report the conflict, also after a
            // different failure in between.
            this.transport.toError('poll_conflict_held', 'poll_conflict');
            return;
        }
        this.lastConflictAtMs = undefined;
        this.transport.toConnected('poll_succeeded');
    }
    /** Detached per-update dispatch; failures log and never stop the poller. */
    async handleUpdateLogged(update, agentName, clientName) {
        try {
            await this.handleUpdate(update);
        }
        catch (err) {
            logger.error({ err, agentName, clientName }, 'Telegram poller update handler failed');
        }
    }
    /**
     * callback_query updates cannot go through parseLocalTelegramUpdate; they
     * ARE valid inputs to the questionnaire/permission interception hooks, so
     * dispatch them with a synthetic ctx for the interception layer to claim.
     */
    async dispatchCallbackQuery(update, cbq) {
        const ctx = synthesizeCallbackQueryCtx(cbq, this.options.defaultAgentName, this.options.clientName);
        if (!ctx)
            return;
        try {
            await this.options.dispatchInbound({
                ctx,
                text: '',
                raw: { update },
                ...(typeof update.update_id === 'number' ? { eventId: String(update.update_id) } : {}),
            });
        }
        catch (err) {
            logger.error({ err, updateKind: 'callback_query' }, 'Telegram poller dispatch failed');
        }
    }
    async handleUpdate(update) {
        // callback_query updates are NOT a normal text message — they cannot
        // go through parseLocalTelegramUpdate (it would reject them). They
        // ARE valid inputs to `tryHandleQuestionnaireReply` and
        // `parsePermissionReply` hooks; route them through the runner with a
        // synthetic ctx so the interception layer can claim them.
        if (isRecord(update.callback_query)) {
            await this.dispatchCallbackQuery(update, update.callback_query);
            return;
        }
        const parsed = parseLocalTelegramUpdate({
            update,
            agentName: this.options.defaultAgentName,
            clientName: this.options.clientName,
            ...(this.options.botName ? { botName: this.options.botName } : {}),
        }, this.options.defaultAgentName);
        if ('error' in parsed)
            return;
        let attachments = [];
        if (this.options.adapter && parsed.attachmentRefs.length > 0) {
            try {
                attachments = await downloadAttachmentsForUnifiedInbound(this.options.adapter, parsed);
            }
            catch (err) {
                logger.error({ err }, 'Telegram poller attachment download failed');
            }
        }
        const dispatchText = ensureUnifiedInboundText(parsed.text, parsed.attachmentRefs);
        try {
            await this.options.dispatchInbound({
                ctx: parsed.ctx,
                text: dispatchText,
                ...(parsed.eventId ? { eventId: parsed.eventId } : {}),
                ...(attachments.length > 0 ? { attachments } : {}),
            });
        }
        catch (err) {
            logger.error({ err }, 'Telegram poller dispatch failed');
        }
    }
}
/**
 * Synthesise a {@link LocalChannelContext} from a `callback_query`
 * payload so the questionnaire / permission intercept layer has a usable
 * chatId + senderId without going through `parseLocalTelegramUpdate`.
 * Returns `null` when the payload lacks the required ids (rare — the
 * Bot API guarantees them on real callback_query updates).
 */
function synthesizeCallbackQueryCtx(cbq, defaultAgentName, clientName) {
    const message = isRecord(cbq.message) ? cbq.message : {};
    const chat = isRecord(message.chat) ? message.chat : {};
    const from = isRecord(cbq.from) ? cbq.from : {};
    const chatId = stringish(chat.id);
    const senderId = stringish(from.id) ?? chatId;
    if (!chatId || !senderId)
        return null;
    return {
        platform: 'telegram',
        chatType: typeof chat.type === 'string' ? chat.type : 'private',
        chatId,
        senderId,
        clientName: clientName || `telegram:${defaultAgentName}`,
        hasMention: true,
    };
}
function stringish(value) {
    if (typeof value === 'string' && value.trim())
        return value;
    if (typeof value === 'number' && Number.isFinite(value))
        return String(value);
    return undefined;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=telegram-poll-wire.js.map