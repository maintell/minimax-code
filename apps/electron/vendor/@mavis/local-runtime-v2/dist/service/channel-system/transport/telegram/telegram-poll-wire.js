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
import { TelegramPoller } from './telegram-poller.js';
import { downloadAttachmentsForUnifiedInbound, ensureUnifiedInboundText, } from './telegram-adapter-shared.js';
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
export class LocalTelegramPollWire {
    poller = null;
    options;
    constructor(options) {
        this.options = options;
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
        this.poller = poller;
        poller.start();
    }
    stop() {
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