/**
 * Migration copy (MR1) of v1 `channels/adapters/wechat/wechat-adapter.ts`.
 */
/**
 * WeChat iLink platform adapter — implements
 * {@link LocalChannelPlatformAdapter} on top of the vendored wechat-sdk +
 * the local-runtime {@link LocalWeChatChannelStore}.
 *
 * Two main responsibilities:
 *   1. Translate the platform-agnostic adapter contract to iLink primitives:
 *      `bind`/`unbind`/`status` go through {@link LocalWeChatChannelStore},
 *      `sendMessage` / `downloadAttachment` go through {@link WeChatRuntimeSdk}.
 *   2. Provide the numbered-text questionnaire bridge so the core
 *      `ask_user` tool can surface on WeChat without a card SDK.
 *
 * The adapter does NOT import the SDK runtime directly. Instead it takes a
 * {@link WeChatRuntimeSdk} dependency that the host wires up in production
 * (importing `./sdk/index.js`) and tests stub.
 *
 * The inbound-attachment helpers and the numbered-text questionnaire helpers
 * live in `wechat-attachments.ts` / `wechat-questionnaire.ts` so this file
 * stays within the 500-line layout budget.
 */
import { detach } from '../../settle.js';
import { prepareChannelOutboundMessage } from '../../delivery/outbound-message.js';
import { LocalChannelClientUnavailableError, } from '../../ingress/runner.js';
import { isUsableWeChatBinding, LocalWeChatChannelStore } from './wechat-store.js';
import { parseLocalWeChatEvent } from './inbound/wechat-events.js';
import { decodeWeChatAttachmentKey, resolveWeChatAttachments, writeWeChatAttachmentFile, } from './inbound/wechat-attachment-support.js';
import { decodeAttachmentKey, extractFileName, extractWeChatAttachmentRefs, guessMimeFromKind, readMediaBuffer, } from './inbound/wechat-attachments.js';
import { readContextTokenFromCtx, readString, WECHAT_CDN_BASE_URL, } from './wechat-adapter-helpers.js';
import { LocalWeChatMonitorWire } from './inbound/wechat-monitor-wire.js';
import { IDLE_CHANNEL_TRANSPORT, } from '../../ingress/channel-transport-status.js';
import { formatPermissionText, parsePermissionCommand } from './wechat-permission.js';
import { formatQuestionnaireText, parseNumberedReply, pendingShellRequest, } from './wechat-questionnaire.js';
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
/**
 * `LocalChannelPlatformAdapter` for WeChat. Each instance is bound to a
 * specific `(agentName, clientName)` pair, mirroring the adapter registry's
 * exact-match contract.
 */
export class LocalWeChatChannelAdapter {
    platform = 'wechat';
    clientName;
    agentName;
    store;
    runner;
    sdk;
    cdnBaseUrl;
    nowMs;
    /** Pending questionnaires keyed by chatId so a reply can be parsed back. */
    pendingByChat = new Map();
    /**
     * Last-seen `context_token` per chatId. iLink requires the inbound message's
     * `context_token` to be echoed back on every outbound reply (the bot can
     * only reply within an established context). The monitor wire calls
     * {@link rememberContextToken} on every inbound USER message so the outbound
     * path (`sendMessage` / `renderQuestionnaire`) can recover it via
     * {@link recallContextToken} even when the runner reconstructs the
     * `LocalChannelContext` and drops the per-message `contextToken` field.
     * Without this fallback, outbound replies fail with
     * `sendTextMessage: contextToken is required` (parity with historical
     * `imGateway/platforms/wechat.ts` which carried the token via
     * `MessageContext.platformSpecific.contextToken`).
     */
    contextTokenByChat = new Map();
    /**
     * Active typing-refresh timers keyed by chatId. iLink typing auto-clears
     * after ~4s, so a turn-long indicator must re-send on a timer; we keep
     * the timer here so {@link notifyTurnEnd} can stop it. Parity with
     * historical `IMGatewayChannelClient.typingTimers`.
     */
    typingTimers = new Map();
    /**
     * Long-poll wire — owns the `ILinkMonitor` instance and the
     * `WeixinMessage → runner.dispatchInbound` translation. Created lazily on
     * `bind()` so a bind-less adapter (test scaffolding) does not start an
     * idle monitor.
     */
    monitorWire = null;
    constructor(options) {
        this.clientName = options.clientName;
        this.agentName = options.agentName;
        this.store = options.store;
        this.runner = options.runner;
        this.sdk = options.sdk;
        if (options.cdnBaseUrl !== undefined)
            this.cdnBaseUrl = options.cdnBaseUrl;
        this.nowMs = options.nowMs ?? (() => Date.now());
    }
    async bind(input) {
        const botToken = readString(input.credentials, ['botToken', 'token']) ??
            readString(input.credentials, ['bot_token']);
        if (!botToken) {
            return {
                ok: false,
                clientName: this.clientName,
                error: 'botToken is required',
                code: 'VALIDATION_ERROR',
            };
        }
        const record = await this.store.bind({
            agentName: input.agentName,
            botToken,
            ilinkBotId: readString(input.credentials, ['ilinkBotId', 'ilink_bot_id']),
            baseUrl: readString(input.credentials, ['baseUrl', 'base_url']),
            webhookToken: readString(input.credentials, ['webhookToken', 'webhook_token']),
            botName: readString(input.credentials, ['botName', 'bot_name']),
            mode: 'polling',
            connected: true,
        });
        // Plan §5.2: a staged / non-winner primary-family record starts nothing.
        // Only the reconciler's winner and the single startup restore may.
        if (record.enabled === false || (await this.store.isPrimaryFamilyAgent(input.agentName))) {
            logger.info({ agentName: input.agentName, platform: 'wechat', clientName: this.clientName }, 'WeChat bind transport start delegated to family reconciler');
            return { ok: true, clientName: this.clientName };
        }
        // Start the iLink long-poll so inbound messages flow into the runner.
        // A failure is observable to the caller; reporting a bound credential
        // while its inbound edge is dark would be a false confirmation.
        await this.ensureMonitorRunning();
        return { ok: true, clientName: this.clientName };
    }
    /**
     * (Re)start the iLink monitor wire. Idempotent: if a wire already exists
     * and is running this is a no-op. Called from `bind()` and from the host
     * `restoreActiveBindings()` path when the runtime boots with a record
     * already on disk (no fresh `bind()` is issued).
     */
    async startMonitor() {
        if (this.monitorWire?.isRunning())
            return true;
        if (!this.monitorWire) {
            this.monitorWire = new LocalWeChatMonitorWire({
                agentName: this.agentName,
                clientName: this.clientName,
                store: this.store,
                runner: this.runner,
                sdk: this.sdk,
                nowMs: this.nowMs,
                downloader: this.makeInboundDownloader(),
                onContextToken: (chatId, token) => this.rememberContextToken(chatId, token),
            });
        }
        await this.monitorWire.start();
        return this.monitorWire.isRunning();
    }
    /**
     * Ensure a *healthy* monitor is running for the current binding.
     * Idempotent and non-thrashing — safe to call on every status poll:
     *   - no-op when a live monitor is already polling the current token,
     *   - force a fresh iLink session only when the monitor is absent, dead
     *     (`session_expired` / `stopped`), or bound to a stale token (rebind).
     *
     * This is the bind-finalised / re-scan / reopen-panel recovery entry point.
     * A plain `startMonitor()` cannot recover a `session_expired` loop because
     * that loop still reports `isRunning()` while sleeping.
     */
    async ensureMonitorRunning() {
        if (!this.monitorWire) {
            await this.startMonitor();
            return;
        }
        const record = await this.store.get(this.agentName);
        const currentToken = record?.botToken ?? '';
        if (this.monitorWire.needsRestart(currentToken)) {
            this.monitorWire.stop();
            this.monitorWire = null;
            await this.startMonitor();
        }
    }
    /**
     * Live inbound-monitor health, for status reporting. `running` reflects the
     * long-poll loop; `status` is the last emitted monitor status
     * (`polling` / `reconnecting` / `session_expired` / `stopped`, or `null`
     * before the first start).
     */
    monitorHealth() {
        return {
            running: this.monitorWire?.isRunning() ?? false,
            status: this.monitorWire?.liveStatus() ?? null,
        };
    }
    /**
     * Live receive-channel state for the Connection list and the legacy
     * status overlay; `undefined` when this adapter's SDK has no monitor
     * (inbound not wired, so there is nothing to report). No wire means
     * nothing was started (or it was stopped by us): `idle`.
     */
    inboundTransportStatus() {
        if (!this.sdk.createMonitor)
            return undefined;
        return this.monitorWire?.transportStatus() ?? IDLE_CHANNEL_TRANSPORT;
    }
    /**
     * Stop the iLink monitor and outstanding typing refreshes without clearing
     * the binding. Teardown can interrupt a live turn, so old timers must not
     * retain the former client after its runtime edge is gone.
     */
    shutdown() {
        const hadMonitor = Boolean(this.monitorWire);
        const clearedTypingTimerCount = this.typingTimers.size;
        logger.info({
            agentName: this.agentName,
            clientName: this.clientName,
            hadMonitor,
            clearedTypingTimerCount,
            reason: 'adapter-shutdown',
        }, 'WeChat monitor shutdown requested (intentional)');
        this.monitorWire?.stop();
        this.monitorWire = null;
        for (const timer of this.typingTimers.values()) {
            clearInterval(timer);
        }
        this.typingTimers.clear();
    }
    /**
     * Build a per-adapter inbound attachment downloader backed by the SDK's
     * `downloadAndDecrypt`. We do NOT touch the module-level slot
     * (`setWeChatAttachmentDownloader`) so concurrent tests / multi-agent
     * setups remain isolated — the downloader is scoped to this adapter.
     */
    makeInboundDownloader() {
        const sdk = this.sdk;
        const store = this.store;
        const agentName = this.agentName;
        const clientName = this.clientName;
        const cdnBaseOverride = this.cdnBaseUrl;
        return async (ref, ctx) => {
            const record = await store.get(agentName);
            if (!isUsableWeChatBinding(record)) {
                throw new Error('WeChat binding not configured');
            }
            const botToken = ctx.botToken ?? record.botToken;
            const cdnBaseUrl = cdnBaseOverride ?? WECHAT_CDN_BASE_URL;
            const { encryptedQueryParam, aesKey } = decodeWeChatAttachmentKey(ref.key);
            if (!encryptedQueryParam) {
                throw new Error('WeChat attachment missing encrypt_query_param');
            }
            // Diagnostic: surface every inbound download attempt so the staging
            // log shows whether refs are being picked up, where the bytes land,
            // and which downloads fail. Mask the encrypted_query_param and never
            // log the aesKey / botToken.
            const refLabel = `${ref.type}/${encryptedQueryParam.slice(0, 12)}…`;
            logger.info({ refLabel, hasAes: Boolean(aesKey) }, 'WeChat inbound attachment download started');
            let buffer;
            try {
                buffer = await sdk.downloadAndDecrypt({
                    encryptedQueryParam,
                    aesKey,
                    cdnBaseUrl,
                    token: botToken,
                });
            }
            catch (err) {
                logger.error({ err, refLabel }, 'WeChat inbound attachment download failed');
                throw err;
            }
            const fileName = ref.name ?? `${ref.type}-${ctx.messageId || Date.now()}`;
            const scope = downloadScope(ctx.sessionId, clientName);
            const filePath = await writeWeChatAttachmentFile({
                dataDir: store.getDataDir(),
                scopeDirName: scope,
                fileName,
                buffer,
            });
            logger.info({ refLabel, bytes: buffer.byteLength, filePath }, 'WeChat inbound attachment download completed');
            return {
                filePath,
                mimeType: ref.mimeType ?? 'application/octet-stream',
                byteLength: buffer.byteLength,
            };
        };
    }
    async unbind(input) {
        // Stop the long-poll before clearing the credentials so the running
        // monitor does not race the deletion (it would otherwise log
        // `No usable WeChat binding` on the next poll loop turn).
        this.monitorWire?.stop();
        this.monitorWire = null;
        const ok = await this.store.unbind(input.agentName);
        return { ok };
    }
    async status(input) {
        const record = await this.store.get(input?.agentName ?? this.agentName);
        const configured = isUsableWeChatBinding(record);
        return {
            configured,
            connected: configured,
            clientName: this.clientName,
            detail: record ? { mode: record.mode, hasIlinkBotId: Boolean(record.ilinkBotId) } : {},
        };
    }
    async normalizeInbound(input) {
        if (!input.raw || typeof input.raw !== 'object') {
            throw new Error('WeChat inbound raw is required');
        }
        const parsed = parseLocalWeChatEvent(input.raw, this.agentName);
        if ('error' in parsed) {
            throw new Error('WeChat inbound parse failed');
        }
        const refs = extractWeChatAttachmentRefs(input.raw);
        return {
            ...parsed,
            attachmentRefs: refs,
        };
    }
    async sendMessage(input) {
        const outbound = prepareChannelOutboundMessage(input);
        const record = await this.store.get(this.agentName);
        if (!isUsableWeChatBinding(record)) {
            return this.appendOutboundError(outbound, 'WeChat binding not configured');
        }
        const client = this.sdk.createClient({
            token: record.botToken,
            ...(record.baseUrl ? { baseUrl: record.baseUrl } : {}),
        });
        const contextToken = this.resolveContextToken(outbound.ctx);
        const cdnBaseUrl = this.cdnBaseUrl ?? WECHAT_CDN_BASE_URL;
        try {
            let messageId;
            const mediaErrors = [];
            if (outbound.text?.trim()) {
                const sent = await this.sdk.sendText({
                    client,
                    to: outbound.ctx.chatId,
                    contextToken,
                    text: outbound.text,
                });
                messageId = sent.messageId;
            }
            for (const media of outbound.media ?? []) {
                const sentId = await this.sendOneMedia({
                    client,
                    chatId: outbound.ctx.chatId,
                    contextToken,
                    cdnBaseUrl,
                    media,
                    mediaErrors,
                });
                if (sentId)
                    messageId = sentId;
            }
            return await this.settleSentOutbound({
                client,
                outbound,
                contextToken,
                messageId,
                mediaErrors,
            });
        }
        catch (err) {
            return this.appendOutboundError(outbound, err instanceof Error ? err.message : String(err));
        }
    }
    /** Audit-append a failed outbound and surface the error to the caller. */
    async appendOutboundError(outbound, error) {
        const recorded = await this.runner.outboundStore.append({
            ctx: outbound.ctx,
            text: outbound.text,
            status: 'error',
            error,
            ...(outbound.sessionId ? { sessionId: outbound.sessionId } : {}),
            ...(outbound.queueItemId ? { queueItemId: outbound.queueItemId } : {}),
        });
        return { id: recorded.id, status: 'error', error };
    }
    /** Success tail: surface media failures to the user, then audit-append. */
    async settleSentOutbound(settle) {
        const { outbound, mediaErrors } = settle;
        let messageId = settle.messageId;
        if (mediaErrors.length > 0) {
            const sent = await this.sdk.sendText({
                client: settle.client,
                to: outbound.ctx.chatId,
                contextToken: settle.contextToken,
                text: mediaErrors.join('\n\n'),
            });
            messageId = sent.messageId;
        }
        const recorded = await this.runner.outboundStore.append({
            ctx: outbound.ctx,
            text: [outbound.text, ...mediaErrors].filter(Boolean).join('\n\n') || '[media]',
            status: 'sent',
            ...(mediaErrors.length > 0 ? { error: mediaErrors.join('\n') } : {}),
            ...(outbound.sessionId ? { sessionId: outbound.sessionId } : {}),
            ...(outbound.queueItemId ? { queueItemId: outbound.queueItemId } : {}),
        });
        return {
            id: messageId ?? recorded.id,
            status: 'sent',
            ...(mediaErrors.length > 0 ? { error: mediaErrors.join('\n') } : {}),
        };
    }
    /**
     * Send one outbound media item; a failure records a user-visible marker in
     * `mediaErrors` and never aborts the remaining items. Uses the
     * OutboundMediaKind ('image'/'audio'/'video'/'file') as the transport
     * selector — `media.type` is a free-form agent string (e.g. 'image',
     * 'png', 'screenshot') and cannot be treated as a MIME; the MIME handed to
     * sendMediaFile derives from the explicit `media.mimeType` when set, else
     * from the kind (parity with historical
     * `imGateway/platforms/wechat.ts:sendMediaAttachment`).
     */
    async sendOneMedia(send) {
        const { media } = send;
        try {
            const buf = await readMediaBuffer(media.path);
            const mimeType = (media.mimeType && media.mimeType.includes('/') ? media.mimeType : undefined) ??
                guessMimeFromKind(media.kind);
            const upload = await this.uploadByKind({
                client: send.client,
                buf,
                toUserId: send.chatId,
                cdnBaseUrl: send.cdnBaseUrl,
                kind: media.kind,
            });
            const sent = await this.sdk.sendMediaFile({
                client: send.client,
                to: send.chatId,
                contextToken: send.contextToken,
                uploaded: upload,
                fileName: media.name ?? extractFileName(media.path),
                mimeType,
            });
            logger.info({ kind: media.kind, name: media.name ?? extractFileName(media.path), mimeType }, 'WeChat outbound media sent');
            return sent.messageId;
        }
        catch (err) {
            const name = media.name ?? extractFileName(media.path) ?? media.kind;
            const msg = err instanceof Error ? err.message : String(err);
            logger.error({ err, kind: media.kind, name }, 'WeChat outbound media failed');
            send.mediaErrors.push(`[媒体发送失败: ${name} — ${msg}]`);
            return undefined;
        }
    }
    async downloadAttachment(input) {
        const record = await this.store.get(this.agentName);
        if (!isUsableWeChatBinding(record)) {
            throw new Error('WeChat binding not configured');
        }
        const { encryptedQueryParam, aesKey } = decodeAttachmentKey(input.ref.key);
        const cdnBaseUrl = this.cdnBaseUrl ?? WECHAT_CDN_BASE_URL;
        const buf = await this.sdk.downloadAndDecrypt({
            encryptedQueryParam,
            aesKey,
            cdnBaseUrl,
            token: record.botToken,
        });
        return {
            type: input.ref.type,
            key: input.ref.key,
            ...(input.ref.name ? { name: input.ref.name } : {}),
            ...(input.ref.mimeType ? { mimeType: input.ref.mimeType } : {}),
            size: buf.byteLength,
        };
    }
    /** Resolve an inbound WeChat ref to a local file via the iLink downloader. */
    async downloadAttachmentToLocal(input) {
        const record = await this.store.get(this.agentName);
        if (!isUsableWeChatBinding(record)) {
            throw new Error('WeChat binding not configured');
        }
        const [resolved] = await resolveWeChatAttachments([input.ref], buildDownloadResolveContext(input, record, this.clientName));
        if (!resolved)
            throw new Error('WeChat adapter: downloader returned no result');
        return {
            type: resolved.type,
            filePath: resolved.filePath,
            fileName: resolved.fileName,
            mimeType: resolved.mimeType,
            ...(resolved.error ? { error: resolved.error } : {}),
        };
    }
    // -------------------------------------------------------------------------
    // Questionnaire
    // -------------------------------------------------------------------------
    async renderQuestionnaire(input) {
        const text = formatQuestionnaireText(input.renderable);
        const record = await this.store.get(this.agentName);
        if (!isUsableWeChatBinding(record)) {
            throw new LocalChannelClientUnavailableError({
                platform: 'wechat',
                clientName: this.clientName,
            });
        }
        const client = this.sdk.createClient({
            token: record.botToken,
            ...(record.baseUrl ? { baseUrl: record.baseUrl } : {}),
        });
        const contextToken = this.resolveContextToken(input.ctx);
        const sent = await this.sdk.sendText({
            client,
            to: input.ctx.chatId,
            contextToken,
            text,
        });
        await this.runner.outboundStore.append({
            ctx: input.ctx,
            text,
            status: 'sent',
        });
        this.rememberPending(input, sent.messageId);
        return { outboundMessageId: sent.messageId };
    }
    async parseQuestionnaireReply(input) {
        if (!input.raw || typeof input.raw !== 'object')
            return null;
        const body = input.raw;
        const parsed = parseLocalWeChatEvent(body, this.agentName);
        if ('error' in parsed)
            return null;
        const text = parsed.text.trim();
        if (!text)
            return null;
        return parseNumberedReply({
            text,
            request: input.pending.request,
        });
    }
    /**
     * Try to interpret an inbound text as a numbered-text questionnaire
     * reply for THIS chat. Returns `null` when there is no pending ask for
     * the chat — the runner then forwards the inbound as a plain user
     * message. On a complete hit, the pending entry is marked in-flight until
     * the host settles the reply.
     */
    async tryHandleQuestionnaireReply(input) {
        const pending = this.pendingByChat.get(input.ctx.chatId);
        if (!pending)
            return null;
        if (pending.inFlight)
            return { handled: true };
        const text = (input.text ?? '').trim();
        if (!text)
            return null;
        const reply = parseNumberedReply({ text, request: pending.request });
        if (!reply)
            return null;
        pending.inFlight = true;
        return { ctx: input.ctx, reply };
    }
    async settleQuestionnaireReply(input) {
        const pending = this.pendingByChat.get(input.ctx.chatId);
        if (!pending || pending.requestId !== input.requestId)
            return;
        if (input.outcome.status === 'retryable') {
            pending.inFlight = false;
            return;
        }
        this.pendingByChat.delete(input.ctx.chatId);
    }
    // -------------------------------------------------------------------------
    // Permission
    // -------------------------------------------------------------------------
    /**
     * Render a pending permission ask as a plain-text WeChat card. The core
     * {@link LocalChannelPermissionBridge} owns the pending map (keyed by
     * `(platform, clientName, chatId)`) and records it after this returns, so —
     * unlike `renderQuestionnaire` — the adapter keeps NO local pending state
     * here.
     *
     * Fail-quiet: the bridge's `onPermissionAsk` wraps this call in try/catch, so
     * a send failure is logged there and never crashes `beforeLocalToolCall`. We
     * deliberately let a hard send error propagate (rather than swallowing it and
     * returning `{}`) so the bridge does NOT record a pending for a card that was
     * never delivered — a user with no visible card must not have a live pending.
     */
    async renderPermission(input) {
        const text = formatPermissionText(input.renderable);
        const record = await this.store.get(this.agentName);
        if (!isUsableWeChatBinding(record)) {
            throw new LocalChannelClientUnavailableError({
                platform: 'wechat',
                clientName: this.clientName,
            });
        }
        const client = this.sdk.createClient({
            token: record.botToken,
            ...(record.baseUrl ? { baseUrl: record.baseUrl } : {}),
        });
        const contextToken = this.resolveContextToken(input.ctx);
        const sent = await this.sdk.sendText({
            client,
            to: input.ctx.chatId,
            contextToken,
            text,
        });
        await this.runner.outboundStore.append({
            ctx: input.ctx,
            text,
            status: 'sent',
        });
        return { outboundMessageId: sent.messageId };
    }
    /**
     * Decode an inbound WeChat message as a permission reply. Called by the
     * bridge ONLY when a pending ask exists for this conversation, so a `null`
     * return simply lets the text flow on as an ordinary message (an ordinary
     * chat message that is not one of the three slash commands is never
     * mis-consumed). The bridge deletes the pending on a non-null result
     * (consume-once).
     *
     * `raw` is the WeChat event body forwarded verbatim by
     * `LocalWeChatMonitorWire` → `runner.dispatchInbound({ raw })`; we run it
     * through the same `parseLocalWeChatEvent` normaliser the questionnaire path
     * uses, then match the (bot-mention-stripped) text against the exact command
     * tokens. Fail-quiet: a non-object / unparseable body returns `null`.
     */
    async parsePermissionReply(input) {
        if (!input.raw || typeof input.raw !== 'object')
            return null;
        const parsed = parseLocalWeChatEvent(input.raw, this.agentName);
        if ('error' in parsed)
            return null;
        const behavior = parsePermissionCommand(parsed.text);
        if (!behavior)
            return null;
        return { behavior };
    }
    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------
    async uploadByKind(params) {
        const { client, buf, toUserId, cdnBaseUrl, kind } = params;
        if (kind === 'image') {
            return this.sdk.uploadImage({ client, buf, toUserId, cdnBaseUrl });
        }
        if (kind === 'video') {
            return this.sdk.uploadVideo({ client, buf, toUserId, cdnBaseUrl });
        }
        // audio + file → uploadFile (WeChat has no voice primitive; audio rides
        // as a file). Matches historical `imGateway/platforms/wechat.ts` which
        // collapsed audio onto sendFileMessage as well.
        return this.sdk.uploadFile({ client, buf, toUserId, cdnBaseUrl });
    }
    async downloadAttachmentBytes(input) {
        const record = await this.store.get(this.agentName);
        if (!isUsableWeChatBinding(record)) {
            throw new Error('WeChat binding not configured');
        }
        const { encryptedQueryParam, aesKey } = decodeWeChatAttachmentKey(input.ref.key);
        return this.sdk.downloadAndDecrypt({
            encryptedQueryParam,
            aesKey,
            cdnBaseUrl: this.cdnBaseUrl ?? WECHAT_CDN_BASE_URL,
            token: record.botToken,
        });
    }
    rememberPending(input, outboundMessageId) {
        const pending = {
            requestId: input.renderable.requestId,
            platform: 'wechat',
            clientName: this.clientName,
            chatId: input.ctx.chatId,
            ...(outboundMessageId ? { outboundMessageId } : {}),
            request: pendingShellRequest(input.renderable),
            createdAt: Date.now(),
        };
        this.pendingByChat.set(input.ctx.chatId, pending);
    }
    /**
     * Cache the inbound message's `context_token` against the chat so the
     * outbound path (`sendMessage` / `renderQuestionnaire`) can recover it
     * even when the runner reconstructs the `LocalChannelContext` and drops
     * the per-message field. Called by `LocalWeChatMonitorWire` on every
     * inbound USER message.
     */
    rememberContextToken(chatId, contextToken) {
        const trimmed = (contextToken ?? '').trim();
        if (!trimmed)
            return;
        this.contextTokenByChat.set(chatId, trimmed);
    }
    /**
     * Recover the `context_token` for an outbound to `chatId`. Prefers the
     * per-message field (set by the wire on the same turn) and falls back to
     * the chat-scoped cache so async continuations (questionnaire submit,
     * deferred replies) still send.
     */
    resolveContextToken(ctx) {
        const fromCtx = readContextTokenFromCtx(ctx);
        if (fromCtx) {
            this.contextTokenByChat.set(ctx.chatId, fromCtx);
            return fromCtx;
        }
        return this.contextTokenByChat.get(ctx.chatId) ?? '';
    }
    /**
     * Start the iLink "对方正在输入" indicator for the turn. iLink typing
     * auto-clears after ~4s, so arm a refresh timer until {@link notifyTurnEnd}
     * stops it. Best-effort — typing must never surface to the turn (every
     * failure is swallowed). Parity with historical
     * `imGateway/platforms/wechat.ts:sendTypingIndicator`.
     */
    async notifyTurnStart(ctx) {
        logger.info({
            chatId: ctx.chatId,
            hasGetConfig: Boolean(this.sdk.getConfig),
            hasSendTyping: Boolean(this.sdk.sendTyping),
        }, 'WeChat typing indicator start requested');
        if (!this.sdk.getConfig || !this.sdk.sendTyping)
            return;
        const record = await this.store.get(this.agentName);
        if (!isUsableWeChatBinding(record)) {
            logger.info({ reason: 'missing_binding' }, 'WeChat typing indicator skipped');
            return;
        }
        const contextToken = this.resolveContextToken(ctx);
        const client = this.sdk.createClient({
            token: record.botToken,
            ...(record.baseUrl ? { baseUrl: record.baseUrl } : {}),
        });
        const fire = async (label) => {
            try {
                const config = await this.sdk.getConfig({
                    client,
                    ilinkUserId: ctx.chatId,
                    ...(contextToken ? { contextToken } : {}),
                });
                if (!config.typingTicket) {
                    logger.info({ label, reason: 'missing_typing_ticket' }, 'WeChat typing indicator skipped');
                    return;
                }
                await this.sdk.sendTyping({
                    client,
                    ilinkUserId: ctx.chatId,
                    typingTicket: config.typingTicket,
                    status: 1,
                });
                logger.info({ label, chatId: ctx.chatId, status: 1 }, 'WeChat typing indicator sent');
            }
            catch (err) {
                logger.warn({ err, label }, 'WeChat typing indicator failed');
            }
        };
        detach(fire('initial'));
        if (this.typingTimers.has(ctx.chatId))
            return;
        const timer = setInterval(() => detach(fire('refresh')), 4000);
        if (typeof timer.unref === 'function')
            timer.unref();
        this.typingTimers.set(ctx.chatId, timer);
    }
    /**
     * Stop the typing-refresh timer and push a CANCEL status. Best-effort.
     * Parity with `imGateway/platforms/wechat.ts:clearTypingIndicator`.
     */
    async notifyTurnEnd(ctx) {
        const timer = this.typingTimers.get(ctx.chatId);
        if (timer) {
            clearInterval(timer);
            this.typingTimers.delete(ctx.chatId);
        }
        if (!this.sdk.getConfig || !this.sdk.sendTyping)
            return;
        const record = await this.store.get(this.agentName);
        if (!isUsableWeChatBinding(record))
            return;
        try {
            const contextToken = this.resolveContextToken(ctx);
            const client = this.sdk.createClient({
                token: record.botToken,
                ...(record.baseUrl ? { baseUrl: record.baseUrl } : {}),
            });
            const config = await this.sdk.getConfig({
                client,
                ilinkUserId: ctx.chatId,
                ...(contextToken ? { contextToken } : {}),
            });
            if (!config.typingTicket)
                return;
            await this.sdk.sendTyping({
                client,
                ilinkUserId: ctx.chatId,
                typingTicket: config.typingTicket,
                status: 2,
            });
        }
        catch {
            // ignore
        }
    }
}
// ---------------------------------------------------------------------------
// Local helpers (kept here — only the adapter uses them)
// ---------------------------------------------------------------------------
/** Re-export the binding record type for downstream call sites. */
/** On-disk scope for downloaded attachments: session first, else client. */
function downloadScope(sessionId, clientName) {
    return sessionId?.trim() || clientName || 'wechat';
}
/** Resolver context for one adapter-scoped attachment download. */
function buildDownloadResolveContext(input, record, fallbackClientName) {
    const sessionId = input.sessionId ?? input.clientName ?? fallbackClientName;
    return {
        messageId: input.messageId ?? '',
        ...(record.botToken ? { botToken: record.botToken } : {}),
        ...(record.baseUrl ? { baseUrl: record.baseUrl } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(input.clientName ? { clientName: input.clientName } : {}),
    };
}
//# sourceMappingURL=wechat-adapter.js.map