/**
 * Migration copy (MR1) of v1 `channels/adapters/telegram/telegram-sender.ts`.
 */
import { settleOrUndefined } from '../../../settle.js';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
import { withRetry } from '../../../delivery/attachment-retry.js';
import { splitTelegramText, TELEGRAM_PLAIN_TEXT_LIMIT, TELEGRAM_RICH_TEXT_LIMIT, } from './telegram-text-split.js';
/**
 * Telegram **outbound** sender (§4.4 O4).
 *
 * Until now the daemon-local Telegram channel was 100 % mock: outbound replies
 * were only appended to the YAML history store, never delivered to Telegram.
 * This module is the first real Bot API send path inside the local runtime —
 * it covers plain text plus the four outbound media kinds the agent can emit
 * (`image` / `video` / `audio` / `file`).
 *
 * Transport protocol (per Telegram Bot API):
 *   - reply → `POST /bot{token}/sendRichMessage` with JSON
 *     `{ chat_id, rich_message: { markdown } }`, falling back to plain
 *     `sendMessage` per chunk when Telegram rejects the rich form.
 *   - text  → `POST /bot{token}/sendMessage` with JSON `{ chat_id, text }`.
 *   - media → `POST /bot{token}/<method>` with `multipart/form-data` carrying
 *     `chat_id`, the file field, and an optional `caption`.
 *
 * The file bytes are resolved on our side: a local absolute path is read from
 * disk, an `http(s)://` URL is fetched. We upload the bytes directly rather
 * than handing Telegram a URL so the sender works for sandbox-local artefacts
 * the public Telegram servers cannot reach.
 *
 * Reliability mirrors the inbound downloader (`local-telegram-attachment-
 * downloader.ts`): every network call is wrapped in {@link withRetry} so a
 * transient 5xx / network blip self-heals, while an HTTP 4xx is a permanent
 * failure that fails fast.
 *
 * SECURITY: the request URL embeds the bot token, and the multipart body
 * embeds the file bytes — neither is ever logged here. Errors surface only the
 * HTTP status. Callers (the channel client) must keep the same discipline.
 */
/** Telegram Bot API origin. Mirrors the inbound downloader's constant. */
const TELEGRAM_API_BASE = 'https://api.telegram.org';
/**
 * Map an {@link OutboundMediaRef.kind} to the Telegram `send*` method and the
 * multipart field name Telegram expects the file under.
 */
const KIND_TO_METHOD = {
    image: { method: 'sendPhoto', field: 'photo' },
    video: { method: 'sendVideo', field: 'video' },
    audio: { method: 'sendAudio', field: 'audio' },
    file: { method: 'sendDocument', field: 'document' },
};
export class TelegramSender {
    botToken;
    fetcher;
    retry;
    constructor(botToken, options = {}) {
        this.botToken = botToken;
        this.fetcher = options.fetcher ?? fetch;
        this.retry = options.retry ?? {};
    }
    /**
     * Send a plain-text message via `sendMessage`. No `parse_mode` is set so the
     * text is delivered verbatim (no Markdown / HTML escaping surprises).
     *
     * Blank text is a no-op — Telegram rejects empty `text`, and the caller
     * already records the (possibly empty) reply in the outbound history store.
     *
     * The optional {@link TelegramInlineKeyboardMarkup} attaches an inline
     * keyboard to the message (used by MR-E1 to render permission cards). The
     * markup is forwarded as `reply_markup` per Bot API spec; passing
     * `undefined` keeps the legacy text-only behaviour unchanged.
     */
    async sendText(chatId, text, replyMarkup, messageThreadId) {
        return this.sendTextWithReply(chatId, text, {
            ...(replyMarkup ? { replyMarkup } : {}),
            ...(messageThreadId !== undefined ? { messageThreadId } : {}),
        });
    }
    /**
     * {@link sendText} plus an optional quote of the inbound message
     * (`reply_parameters`). Kept as a separate entry point so the four-argument
     * `sendText` signature — and every existing caller of it — stays unchanged.
     */
    async sendTextWithReply(chatId, text, options = {}) {
        if (!text.trim())
            return undefined;
        return withRetry(async () => {
            const body = { chat_id: chatId, text };
            if (options.replyMarkup)
                body.reply_markup = options.replyMarkup;
            // Forum topic reply: Telegram routes the message into the topic when
            // `message_thread_id` is set. Absent → message lands in the General
            // (top-level) chat, preserving the legacy behaviour.
            const threadId = toMessageThreadId(options.messageThreadId);
            if (threadId !== undefined)
                body.message_thread_id = threadId;
            const replyParameters = toReplyParameters(options.replyToMessageId);
            if (replyParameters)
                body.reply_parameters = replyParameters;
            const response = await this.fetcher(this.endpoint('sendMessage'), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
            return await this.finishSend(response, {
                chatId,
                method: 'sendMessage',
                ...(options.replyToMessageId !== undefined
                    ? { replyToMessageId: options.replyToMessageId }
                    : {}),
            });
        }, this.retry);
    }
    /**
     * Send an agent reply as Markdown via `sendRichMessage`, the same rich path
     * the cloud gateway uses. Telegram renders GFM (headings, lists, tables,
     * fenced code) and accepts far more text per message than `sendMessage`
     * ({@link TELEGRAM_RICH_TEXT_LIMIT} vs {@link TELEGRAM_PLAIN_TEXT_LIMIT}).
     *
     * Behaviour:
     *   - blank text is a no-op (Telegram rejects an empty body);
     *   - text over the rich cap is split and sent as several rich messages, in
     *     order, so the reply reads top to bottom;
     *   - a chunk Telegram rejects with a **400** (bad Markdown, text too long,
     *     an account without the rich feature) falls back to plain `sendMessage`
     *     for **that chunk only**, split at the plain cap — chunks already
     *     delivered are never resent and later chunks still try rich first;
     *   - every other failure — 429 rate limit, 401 / 403 / 404, 5xx, network —
     *     keeps the shared {@link withRetry} policy and ultimately throws,
     *     exactly like {@link sendText}.
     *
     * Returns the `message_id` of the **last** message sent, or `undefined` when
     * nothing was sent.
     */
    async sendRichText(chatId, text, messageThreadId, replyToMessageId) {
        if (!text.trim())
            return undefined;
        const chunks = splitTelegramText(text, TELEGRAM_RICH_TEXT_LIMIT);
        if (chunks.length > 1) {
            logger.info({ mode: 'rich', textLength: text.length, chunks: chunks.length }, 'Telegram outbound text split');
        }
        let last;
        // Only the first delivered chunk quotes the inbound message; the rest
        // continue the same reply and would otherwise all point back at it.
        const quote = new SingleReplyQuote(replyToMessageId);
        for (const chunk of chunks) {
            // A whitespace-only chunk carries nothing; Telegram rejects an empty
            // body, so drop it instead of burning a request on it.
            if (!chunk.trim())
                continue;
            last = (await this.sendRichChunk(chatId, chunk, messageThreadId, quote.take())) ?? last;
        }
        return last;
    }
    /**
     * Send one rich chunk, degrading to plain text when Telegram answers 400.
     *
     * Only a 400 means "this rich payload was refused" (bad Markdown, text too
     * long, rich feature unavailable) — the same rule the cloud `im_gateway`
     * applies. A 429 is a rate limit and a 401 / 403 / 404 is a token or
     * permission problem: re-sending the same text through `sendMessage` would
     * fail the same way, so those propagate untouched, as does a 5xx / network
     * error.
     */
    async sendRichChunk(chatId, chunk, messageThreadId, replyToMessageId) {
        try {
            return await this.sendRichMessage(chatId, chunk, messageThreadId, replyToMessageId);
        }
        catch (err) {
            if (readErrorStatus(err) !== 400)
                throw err;
            if (replyToMessageId === undefined) {
                return await this.sendPlainFallback(chatId, chunk, { messageThreadId, cause: err });
            }
            // `sendRichMessage` is not a documented Bot API method, so it may refuse
            // `reply_parameters`. A 400 creates no message, so retrying the same rich
            // payload without the quote is safe and keeps the formatting; only if that
            // also fails do we degrade to plain text (which does support the quote).
            try {
                const sent = await this.sendRichMessage(chatId, chunk, messageThreadId);
                logger.warn({
                    chatId,
                    textLength: chunk.length,
                    replyToMessageId,
                    quoteDropped: true,
                    errorStatus: readErrorStatus(err),
                }, 'Telegram rich send dropped its reply quote');
                return sent;
            }
            catch (retryErr) {
                if (readErrorStatus(retryErr) !== 400)
                    throw retryErr;
                return await this.sendPlainFallback(chatId, chunk, {
                    messageThreadId,
                    cause: retryErr,
                    replyToMessageId,
                });
            }
        }
    }
    /** One `sendRichMessage` round-trip, retried like every other send. */
    async sendRichMessage(chatId, markdown, messageThreadId, replyToMessageId) {
        return withRetry(async () => {
            const body = { chat_id: chatId, rich_message: { markdown } };
            const threadId = toMessageThreadId(messageThreadId);
            if (threadId !== undefined)
                body.message_thread_id = threadId;
            const replyParameters = toReplyParameters(replyToMessageId);
            if (replyParameters)
                body.reply_parameters = replyParameters;
            const response = await this.fetcher(this.endpoint('sendRichMessage'), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
            return await this.finishSend(response, {
                chatId,
                method: 'sendRichMessage',
                ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
            });
        }, this.retry);
    }
    /**
     * Re-send a rich-rejected chunk as plain `sendMessage` pieces (no
     * `parse_mode`, so the Markdown is delivered verbatim). Logs the degradation
     * without the message body — only sizes and Telegram's own error text.
     */
    async sendPlainFallback(chatId, chunk, options) {
        const plainChunks = splitTelegramText(chunk, TELEGRAM_PLAIN_TEXT_LIMIT);
        logger.warn({
            chatId,
            textLength: chunk.length,
            errorStatus: readErrorStatus(options.cause),
            description: readErrorDescription(options.cause),
            plainChunks: plainChunks.length,
        }, 'Telegram rich send fell back to plain');
        if (plainChunks.length > 1) {
            logger.info({ mode: 'plain', textLength: chunk.length, chunks: plainChunks.length }, 'Telegram outbound text split');
        }
        let last;
        const quote = new SingleReplyQuote(options.replyToMessageId);
        for (const piece of plainChunks) {
            // Same guard as the rich loop: a whitespace-only piece is not a message.
            if (!piece.trim())
                continue;
            const anchor = quote.take();
            last =
                (await this.sendTextWithReply(chatId, piece, {
                    ...(options.messageThreadId !== undefined
                        ? { messageThreadId: options.messageThreadId }
                        : {}),
                    ...(anchor !== undefined ? { replyToMessageId: anchor } : {}),
                })) ?? last;
        }
        return last;
    }
    /**
     * Acknowledge a Telegram inline-keyboard click via `answerCallbackQuery`.
     * Without this, the clicked button keeps spinning until Telegram times out
     * the callback. Optional `text` appears as Telegram's lightweight toast.
     */
    async answerCallbackQuery(callbackQueryId, options = {}) {
        await withRetry(async () => {
            const body = { callback_query_id: callbackQueryId };
            if (options.text)
                body.text = options.text;
            if (options.showAlert !== undefined)
                body.show_alert = options.showAlert;
            const response = await this.fetcher(this.endpoint('answerCallbackQuery'), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
            await this.assertOk(response, 'answerCallbackQuery');
        }, this.retry);
    }
    /** Edit a previously sent text message and, optionally, replace its keyboard. */
    async editMessageText(chatId, messageId, text, replyMarkup) {
        await withRetry(async () => {
            const body = { chat_id: chatId, message_id: messageId, text };
            if (replyMarkup)
                body.reply_markup = replyMarkup;
            const response = await this.fetcher(this.endpoint('editMessageText'), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
            await this.assertOk(response, 'editMessageText');
        }, this.retry);
    }
    /**
     * Send a chat action (e.g. "typing") via `sendChatAction`. Telegram shows the
     * action for ~5s then auto-clears, so the caller re-sends on a timer for the
     * duration of a turn. Best-effort: wrapped in withRetry like the other sends;
     * the token is in the URL and is never logged.
     */
    async sendChatAction(chatId, action = 'typing') {
        await withRetry(async () => {
            const response = await this.fetcher(this.endpoint('sendChatAction'), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, action }),
            });
            await this.assertOk(response, 'sendChatAction');
        }, this.retry);
    }
    /**
     * Send a single media attachment. The bytes are resolved first (local path
     * or `http(s)://`), then uploaded as `multipart/form-data` to the per-kind
     * `send*` method.
     */
    async sendMedia(chatId, ref, messageThreadId, replyToMessageId) {
        const { method, field } = KIND_TO_METHOD[ref.kind];
        const buffer = await this.resolveBytes(ref.path);
        const fileName = ref.name || basename(ref.path) || 'attachment';
        await withRetry(async () => {
            const form = new FormData();
            form.set('chat_id', chatId);
            const threadId = toMessageThreadId(messageThreadId);
            if (threadId !== undefined)
                form.set('message_thread_id', String(threadId));
            const replyParameters = toReplyParameters(replyToMessageId);
            // Multipart fields carry JSON-encoded values as strings.
            if (replyParameters)
                form.set('reply_parameters', JSON.stringify(replyParameters));
            // Normalize Buffer<ArrayBufferLike> for Node 22's DOM BlobPart type.
            form.set(field, new Blob([new Uint8Array(buffer)]), fileName);
            if (ref.caption)
                form.set('caption', ref.caption);
            const response = await this.fetcher(this.endpoint(method), {
                method: 'POST',
                body: form,
            });
            await this.finishSend(response, {
                chatId,
                method,
                ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
            });
        }, this.retry);
    }
    /**
     * Resolve the raw bytes behind a media ref. `http(s)://` URLs are fetched;
     * everything else is treated as a local filesystem path and read directly.
     * Never logs the path contents.
     */
    async resolveBytes(path) {
        if (/^https?:\/\//iu.test(path)) {
            const response = await this.fetcher(path, { method: 'GET' });
            if (!response.ok) {
                throw withStatus(new Error(`fetch media HTTP ${response.status}`), response.status);
            }
            const arrayBuffer = await response.arrayBuffer();
            return Buffer.from(arrayBuffer);
        }
        return readFile(path);
    }
    /** Compose a Bot API endpoint URL. Contains the token — never log this. */
    endpoint(method) {
        return `${TELEGRAM_API_BASE}/bot${this.botToken}/${method}`;
    }
    /**
     * Settle one send response: reject a non-2xx through {@link assertOk}, read
     * the sent `message_id`, and — when a quote was requested — record whether
     * Telegram actually applied it.
     *
     * `quoteApplied` is the observable verdict, not our intent: the Bot API only
     * echoes `result.reply_to_message` on a message it really anchored to the
     * quoted one, so a `false` here means the quote silently did not land (an
     * `allow_sending_without_reply` delivery of a deleted message, or the
     * non-standard rich endpoint ignoring `reply_parameters`). Only the chat id,
     * the method and the anchor id are logged — never the body or the token.
     */
    async finishSend(response, params) {
        await this.assertOk(response, params.method);
        const outcome = readTelegramSendOutcome((await settleOrUndefined(response.json())));
        if (params.replyToMessageId !== undefined) {
            logger.info({
                chatId: params.chatId,
                method: params.method,
                replyToMessageId: params.replyToMessageId,
                quoteApplied: outcome.quoteApplied,
            }, 'Telegram outbound reply quote');
        }
        return outcome.messageId !== undefined ? { messageId: outcome.messageId } : undefined;
    }
    /**
     * Throw on a non-2xx Telegram response. The thrown error carries `status` so
     * {@link withRetry} can tell a transient 5xx (retry) from a permanent 4xx
     * (fail fast).
     *
     * The error message also carries Telegram's own `description` (and
     * `error_code` as a structured field) so operators can tell `message is too
     * long` from `RICH_MESSAGE_TEXT_TOO_LONG` in the logs. The rich→plain
     * fallback keys on the HTTP status, not on this text. Only Telegram's error
     * envelope is read; the request body and the token never reach the message.
     */
    async assertOk(response, method) {
        if (response.ok)
            return;
        const detail = await readTelegramErrorDetail(response);
        const suffix = detail.description ? `: ${detail.description}` : '';
        const error = withStatus(new Error(`telegram ${method} HTTP ${response.status}${suffix}`), response.status);
        if (detail.description !== undefined)
            error.telegramDescription = detail.description;
        if (detail.errorCode !== undefined)
            error.telegramErrorCode = detail.errorCode;
        throw error;
    }
}
/** Attach an HTTP `status` to an error so `withRetry` can classify it. */
function withStatus(err, status) {
    const typed = err;
    typed.status = status;
    return typed;
}
/** HTTP status carried by a send failure, when present. */
function readErrorStatus(err) {
    const status = err?.status;
    return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}
/** Telegram's own error text, used for logs that must not carry the body. */
function readErrorDescription(err) {
    const description = err?.telegramDescription;
    return typeof description === 'string' && description ? description : undefined;
}
/**
 * Read `error_code` / `description` off a failed Bot API response. A body that
 * is absent or not JSON degrades to the bare `telegram <method> HTTP <status>`
 * message.
 */
async function readTelegramErrorDetail(response) {
    const json = (await settleOrUndefined(response.json()));
    if (!isRecord(json))
        return {};
    const description = typeof json.description === 'string' && json.description ? json.description : undefined;
    const errorCode = typeof json.error_code === 'number' && Number.isFinite(json.error_code)
        ? json.error_code
        : undefined;
    return {
        ...(description !== undefined ? { description } : {}),
        ...(errorCode !== undefined ? { errorCode } : {}),
    };
}
/**
 * One quote per reply: the first thing a reply actually sends carries the
 * `reply_parameters`, and everything after it continues the same reply instead
 * of pointing back at the original message again.
 */
export class SingleReplyQuote {
    replyToMessageId;
    used = false;
    constructor(replyToMessageId) {
        this.replyToMessageId = replyToMessageId;
    }
    /** The anchor for the next send, or `undefined` once it has been used. */
    take() {
        if (this.used)
            return undefined;
        this.used = true;
        return this.replyToMessageId;
    }
}
/**
 * Coerce an inbound `ctx.sourceMessageId` into the numeric `message_id` a Bot
 * API `reply_parameters` needs. `undefined` for empty / non-numeric input so
 * callers simply omit the quote.
 */
export function toTelegramReplyAnchor(sourceMessageId) {
    return toPositiveIntId(sourceMessageId);
}
/**
 * Bot API `reply_parameters` quoting one inbound message.
 * `allow_sending_without_reply` keeps the reply deliverable when the quoted
 * message was deleted in the meantime — a quote is never worth losing a reply.
 */
function toReplyParameters(replyToMessageId) {
    if (replyToMessageId === undefined || !Number.isInteger(replyToMessageId))
        return undefined;
    return { message_id: replyToMessageId, allow_sending_without_reply: true };
}
/**
 * Coerce an inbound thread id into the numeric `message_thread_id` Telegram's
 * Bot API expects. `ChannelContext.threadId` is a string (unified across
 * platforms); Telegram forum topic ids are integers. Returns `undefined` for
 * empty / non-numeric input so callers simply omit the field.
 */
function toMessageThreadId(value) {
    return toPositiveIntId(value);
}
/**
 * The Bot API takes message and thread ids as positive integers, while the
 * unified channel context carries both as strings. Empty, non-numeric and
 * non-positive input all read as "no id", so callers simply omit the field.
 */
function toPositiveIntId(value) {
    if (value === undefined)
        return undefined;
    const parsed = Number(value.trim());
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
/**
 * Read one successful send response: the sent `message_id` plus whether
 * Telegram echoed `result.reply_to_message`, which it only does for a message
 * it actually anchored to the quoted one.
 */
function readTelegramSendOutcome(json) {
    if (!isRecord(json) || !isRecord(json.result))
        return { quoteApplied: false };
    const messageId = json.result.message_id;
    return {
        ...(typeof messageId === 'number' && Number.isFinite(messageId) ? { messageId } : {}),
        quoteApplied: isRecord(json.result.reply_to_message),
    };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=telegram-sender.js.map