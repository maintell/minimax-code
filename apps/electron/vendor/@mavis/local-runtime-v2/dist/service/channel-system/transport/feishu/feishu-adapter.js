import { prepareChannelOutboundMessage } from '../../delivery/outbound-message.js';
import { feishuClientId, } from './feishu-store.js';
import { feishuMessageSnapshotToQuotedMessage, parseLocalFeishuEvent } from './feishu-events.js';
import { buildQuestionnaireCard, buildReplyCard, unwrapMaybeEncryptedFeishuEvent, } from './cards/feishu-card.js';
import { buildPermissionCard, extractPermissionActionValue, } from './cards/feishu-permission-card.js';
import { FeishuSender, } from './outbound/feishu-sender.js';
import { enrichFeishuSenderName } from './outbound/feishu-sender-name.js';
import { makeFeishuWsAttachmentDownloader, removeAckReaction, startFeishuEventDispatcher, } from './feishu-ws.js';
import { errorMessage, isUsableFeishuBinding, normalizeMode, pickString, } from './feishu-adapter-utils.js';
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
import { buildFeishuSdkLoggerBridge, clearFeishuWsError, describeFeishuWsStatus, transitionFeishuWsStatus, } from './feishu-sdk-logger.js';
import { summarizeFeishuSdkMessage } from './feishu-sdk-message-summary.js';
/**
 * Numeric value of the SDK's `LoggerLevel.debug` (SDK 1.60.0 enum:
 * fatal=0 … info=3, debug=4, trace=5). Fallback for an SDK build that does
 * not export the enum.
 */
const FEISHU_SDK_LOGGER_LEVEL_DEBUG = 4;
/**
 * Concrete adapter instance bound to a single agentName. Re-bind through
 * the store rotates credentials in-place; the cached sender + WS client are
 * torn down so the next call uses the fresh values.
 */
export class FeishuPlatformAdapter {
    platform = 'feishu';
    clientName;
    store;
    agentName;
    defaultAgentName;
    senderOptions;
    wsClientFactory;
    onQuestionnaireRendered;
    onPermissionRendered;
    onBindingChanged;
    pendingThinkingStore;
    pendingReactionStore;
    botName;
    wsAttachmentDownloader;
    attachmentDownloader;
    sender;
    senderForCredentials;
    wsClient;
    /** Last detached WS close; observable for tests/drain, never awaited inline. */
    wsClosePromise;
    /**
     * Live WS transport state — see {@link FeishuWsStatusInfo}. One mutable
     * object shared with the SDK logger bridge so SDK-signalled transitions
     * (handshake success / failure, drops) land where `getWsStatus` reads.
     * Status writes go through {@link transitionWs} only.
     */
    ws = { status: 'idle' };
    /**
     * `retire()` of each SDK logger bridge, keyed by the client it logs for,
     * so teardown detaches exactly the client it closes. Only the default
     * factory registers here; injected factories bring no bridge.
     */
    wsBridgeRetirers = new WeakMap();
    constructor(input, options = {}) {
        this.store = input.store;
        this.agentName = input.agentName.trim() || 'mavis';
        this.defaultAgentName = options.defaultAgentName ?? this.agentName;
        this.clientName = options.clientName ?? feishuClientId(this.agentName);
        this.senderOptions = options.senderOptions ?? {};
        this.wsClientFactory =
            options.wsClientFactory ?? ((factoryInput) => this.createDefaultWsClient(factoryInput));
        // exactOptionalPropertyTypes-friendly: only assign what was provided.
        this.attachmentDownloader = options.attachmentDownloader;
        this.onQuestionnaireRendered = options.onQuestionnaireRendered;
        this.onPermissionRendered = options.onPermissionRendered;
        this.onBindingChanged = options.onBindingChanged;
        this.pendingThinkingStore = options.pendingThinkingStore;
        this.pendingReactionStore = options.pendingReactionStore;
        this.botName = options.botName;
        this.wsAttachmentDownloader = options.wsAttachmentDownloader;
    }
    /**
     * Default WS client factory: dynamic-import the Lark SDK and bridge its
     * internal logger into our pino facade so every runtime WS lifecycle event
     * (connect success/failure, reconnect attempts, close, error, `unable to
     * connect after N tries`) is captured with the same trace context,
     * agentName tag, and disk fan-out as the rest of local-runtime. Without
     * this bridge the SDK writes to `console.*` — those lines never make it
     * into the diagnostic bundle, so a user reporting "WS drops mid-session"
     * would give us zero evidence to inspect.
     */
    async createDefaultWsClient(factoryInput) {
        const sdkSpecifier = '@larksuiteoapi/node-sdk';
        const sdk = (await import(sdkSpecifier));
        // Debug, not the SDK default `info`: the SDK filters by level BEFORE
        // calling our logger, and the handshake verdicts (`ws connect success`,
        // `reconnect success`, `client closed`) are debug lines — at `info` the
        // bridge never sees a connection come up. Trace (ping/pong) stays off.
        const sdkDebugLevel = sdk.LoggerLevel?.debug;
        const loggerLevel = sdkDebugLevel ?? FEISHU_SDK_LOGGER_LEVEL_DEBUG;
        logger.info({
            agentName: this.agentName,
            platform: 'feishu',
            sdkLoggerLevel: loggerLevel,
            // `fallback` means the SDK build did not export `LoggerLevel`; the
            // numeric value then comes from FEISHU_SDK_LOGGER_LEVEL_DEBUG.
            sdkLoggerLevelSource: sdkDebugLevel === undefined ? 'fallback' : 'sdk',
        }, 'Feishu WS SDK client constructing');
        const sdkBridge = buildFeishuSdkLoggerBridge({ agentName: this.agentName, state: this.ws });
        const client = new sdk.WSClient({
            appId: factoryInput.appId,
            appSecret: factoryInput.appSecret,
            ...(factoryInput.domain ? { domain: factoryInput.domain } : {}),
            logger: sdkBridge.logger,
            loggerLevel,
        });
        // One bridge per client: `invalidateTransport` retires it before close().
        this.wsBridgeRetirers.set(client, sdkBridge.retire);
        return client;
    }
    /** Credential + mode gates for bind(); mock mode is rejected outright. */
    validateBindCredentials(credentials) {
        const appId = pickString(credentials, ['appId', 'app_id']);
        const appSecret = pickString(credentials, ['appSecret', 'app_secret']);
        if (!appId || !appSecret) {
            return {
                error: {
                    ok: false,
                    clientName: this.clientName,
                    error: 'appId and appSecret are required',
                    code: 'VALIDATION_ERROR',
                },
            };
        }
        const requestedMode = pickString(credentials, ['mode'])?.toLowerCase();
        if (requestedMode === 'mock') {
            return {
                error: {
                    ok: false,
                    clientName: this.clientName,
                    error: 'mock channel mode is not supported',
                    code: 'CHANNEL_MOCK_MODE_UNSUPPORTED',
                },
            };
        }
        if (requestedMode && !['webhook', 'websocket', 'ws'].includes(requestedMode)) {
            return {
                error: {
                    ok: false,
                    clientName: this.clientName,
                    error: 'unsupported channel mode',
                    code: 'VALIDATION_ERROR',
                },
            };
        }
        return { appId, appSecret, mode: normalizeMode(requestedMode) };
    }
    async bind(input) {
        const credentials = input.credentials ?? {};
        const validated = this.validateBindCredentials(credentials);
        if ('error' in validated)
            return validated.error;
        const { appId, appSecret, mode } = validated;
        const agentName = input.agentName?.trim() || this.agentName;
        const pick = (keys) => pickString(credentials, keys);
        const verificationToken = pick(['verificationToken', 'verification_token', 'token']);
        const encryptKey = pick(['encryptKey', 'encrypt_key', 'encryptToken', 'encrypt_token']);
        const botName = pick(['botName', 'bot_name']);
        const record = await this.store.bind({
            agentName,
            appId,
            appSecret,
            ...(verificationToken ? { verificationToken } : {}),
            ...(encryptKey ? { encryptKey } : {}),
            ...(botName ? { botName } : {}),
            mode,
        });
        // Plan §5.2: a staged / non-winner primary-family record starts nothing.
        // Only the reconciler's winner and the single startup restore may.
        if (record.enabled === false || (await this.store.isPrimaryFamilyAgent(agentName))) {
            logger.info({ agentName, platform: 'feishu', clientName: this.clientName }, 'Feishu bind transport start delegated to family reconciler');
            return { ok: true, clientName: this.clientName };
        }
        await this.onBindingChanged?.(record);
        await this.restartTransportAfterBind(record);
        return {
            ok: true,
            clientName: this.clientName,
        };
    }
    /**
     * Invalidate cached transport on credential change so the next send mints
     * a fresh tenant_access_token + (optionally) a fresh WS client. WS startup
     * failure never fails the bind — the credential is already persisted.
     */
    async restartTransportAfterBind(record) {
        this.invalidateTransport();
        if (record.mode === 'websocket' && this.wsClientFactory !== false) {
            try {
                await this.ensureWsClient(record);
            }
            catch {
                /* swallow — bind succeeds regardless of WS availability */
            }
        }
    }
    async unbind(input) {
        const agentName = input.agentName?.trim() || this.agentName;
        const ok = await this.store.unbind(agentName);
        this.invalidateTransport();
        return { ok };
    }
    async status(input) {
        const agentName = input?.agentName?.trim() || this.agentName;
        const record = await this.store.get(agentName);
        const configured = isUsableFeishuBinding(record);
        // Prefer the bot's real Feishu app name (fetched live, cached) over the
        // placeholder label stored at onboard time. Best-effort: fall back to the
        // stored botName if the lookup is unavailable (permissions / offline).
        let botName = record?.botName;
        if (record && configured) {
            const liveName = await this.resolveBotName(record);
            if (liveName)
                botName = liveName;
        }
        return {
            configured,
            connected: Boolean(record?.connected && record?.enabled),
            clientName: this.clientName,
            detail: record
                ? {
                    mode: record.mode,
                    enabled: record.enabled,
                    hasEncryptKey: Boolean(record.encryptKey),
                    hasVerificationToken: Boolean(record.verificationToken),
                    ...(botName ? { botName } : {}),
                }
                : { mode: 'unconfigured' },
        };
    }
    /**
     * Decode an inbound webhook body (already-parsed JSON) into the canonical
     * envelope. Handles the encrypt envelope before delegating to the
     * existing `parseLocalFeishuEvent` so this adapter remains the single
     * entry point that knows about Feishu's transport peculiarities.
     *
     * Throws when the body is unrecoverable (decrypt failed, no message
     * shape). The caller — the infra route handler — translates the throw
     * into a 4xx response so a misconfigured webhook fails fast.
     */
    async normalizeInbound(input) {
        const record = await this.store.get(this.agentName);
        const body = input.raw && typeof input.raw === 'object' && !Array.isArray(input.raw)
            ? input.raw
            : {};
        const unwrapped = unwrapMaybeEncryptedFeishuEvent(body, record?.encryptKey);
        if (!unwrapped) {
            throw new Error('feishu inbound encrypt payload could not be decoded');
        }
        const enriched = isUsableFeishuBinding(record)
            ? await enrichFeishuSenderName(unwrapped, this.ensureSender(record))
            : unwrapped;
        const resolvedBotIdentity = await this.resolveInboundBotIdentity(record);
        const envelope = parseLocalFeishuEvent(enriched, this.defaultAgentName, resolvedBotIdentity);
        if ('error' in envelope) {
            throw new Error('feishu inbound payload is not a recognised message event');
        }
        // The parser fills `clientName` from the body; override here so a
        // multi-instance host always sees this adapter's own client name on the
        // envelope (parser is shared across the legacy webhook route too).
        envelope.ctx.clientName = this.clientName;
        const quotedMessage = await this.resolveQuotedMessageForEnvelope(envelope, record);
        if (quotedMessage)
            envelope.quotedMessage = quotedMessage;
        return envelope;
    }
    /**
     * Bot identity for mention matching: live identity from the sender when the
     * binding is usable, with the stored botName as a fallback display name.
     */
    async resolveInboundBotIdentity(record) {
        const botIdentity = isUsableFeishuBinding(record)
            ? await this.ensureSender(record).getBotIdentity()
            : undefined;
        if (botIdentity) {
            return {
                ...botIdentity,
                ...(!botIdentity.name && record?.botName ? { name: record.botName } : {}),
            };
        }
        return record?.botName ? { name: record.botName } : undefined;
    }
    async resolveQuotedMessageByThreadId(threadId) {
        const record = await this.store.get(this.agentName);
        return this.resolveQuotedMessageFromRecord(threadId, record);
    }
    /**
     * Resolve the bot's real Feishu display name (app name) for a binding record.
     * Best-effort: returns `undefined` when credentials are missing or the live
     * lookup fails, so callers keep the stored placeholder.
     */
    async resolveBotName(record) {
        if (!isUsableFeishuBinding(record))
            return undefined;
        try {
            return await this.ensureSender(record).getBotName();
        }
        catch {
            return undefined;
        }
    }
    /**
     * Compute the thread-reply option for an outbound send. When the ctx lives
     * inside a Feishu thread/topic (`ctx.threadId` set) AND we hold a concrete
     * anchor message ID inside that thread, the send is routed through the
     * `reply` endpoint (`reply_in_thread`). The anchor prefers the triggering
     * message ID; falls back to the pending thinking card's inbound message ID.
     * No threadId / no anchor → `undefined` (top-level send, unchanged).
     * Shared by {@link sendMessage} and {@link renderPermission} so permission
     * cards route exactly like normal replies.
     */
    resolveThreadReply(ctx) {
        const threadAnchorId = ctx.sourceMessageId ?? this.pendingThinkingStore?.get(ctx.chatId)?.inboundMessageId;
        return ctx.threadId && threadAnchorId ? { replyToMessageId: threadAnchorId } : undefined;
    }
    /**
     * Send an outbound message. The three message parts (`text` / `media` /
     * `questionnaire`) are additive per the contract:
     *   - `questionnaire` present → interactive card first
     *   - then per-media uploads (best-effort: one failure does not block
     *     the others, but the overall result reports the FIRST error so the
     *     caller's retry policy still kicks in)
     *   - then plain text (if non-empty)
     *
     * Returns the platform message id of the LAST successful send, or
     * `'error'` status with the first failure surfaced.
     */
    async sendMessage(input) {
        const executionFailure = Boolean(input.error);
        const outbound = prepareChannelOutboundMessage(input);
        const record = await this.store.get(this.agentName);
        if (!isUsableFeishuBinding(record)) {
            return {
                id: '',
                status: 'error',
                error: 'feishu binding is not configured',
            };
        }
        const sender = this.ensureSender(record);
        const chatId = outbound.ctx.chatId;
        // Thread-aware reply: when the inbound message lived inside a Feishu
        // thread/topic (`ctx.threadId` set), route every outbound send through the
        // `reply` endpoint anchored on a message ID inside that thread, so the
        // reply lands in the thread instead of the top-level conversation.
        const thread = this.resolveThreadReply(outbound.ctx);
        // Inbound message id whose 👀 `OnIt` ack reaction should be revoked once
        // the reply is delivered. MUST be resolved before the questionnaire path
        // below deletes the pending thinking card (its `inboundMessageId` is the
        // fallback when the ctx carries no `sourceMessageId`).
        const ackInboundMessageId = outbound.ctx.sourceMessageId ?? this.pendingThinkingStore?.get(chatId)?.inboundMessageId;
        const revokeAckReaction = () => removeAckReaction({
            store: this.pendingReactionStore,
            inboundMessageId: ackInboundMessageId,
            remove: (m, r) => sender.removeReaction(m, r),
        });
        const state = { lastId: '' };
        if (outbound.questionnaire) {
            await this.sendQuestionnairePart({
                questionnaire: outbound.questionnaire,
                sender,
                chatId,
                thread,
                revokeAckReaction,
                state,
            });
        }
        await this.sendMediaParts(outbound, sender, thread, state);
        // Feishu Card 2.0 form already carries the question text inside the card.
        // Avoid double-posting a tail text when a questionnaire is rendered —
        // historical behaviour (`feat/im-genui-full-mr`) was card-only.
        if (outbound.text.trim() && !outbound.questionnaire) {
            await this.sendReplyCardPart({
                text: outbound.text,
                executionFailure,
                sender,
                chatId,
                thread,
                revokeAckReaction,
                state,
            });
        }
        if (state.firstError) {
            return {
                id: state.lastId,
                status: 'error',
                error: state.firstError,
            };
        }
        return { id: state.lastId, status: 'sent' };
    }
    /**
     * Questionnaire bubble: consume any pending "🤔 思考中…" grey card by
     * patching it into the questionnaire card so the chat stays at one bubble
     * per turn; fall back to a fresh card.
     */
    async sendQuestionnairePart(part) {
        const { questionnaire, sender, chatId, thread, state } = part;
        try {
            const card = buildQuestionnaireCard(questionnaire);
            const pendingThinking = this.pendingThinkingStore?.get(chatId);
            let messageId;
            if (pendingThinking) {
                this.pendingThinkingStore?.delete(chatId);
                try {
                    await sender.patchCard(pendingThinking.messageId, card);
                    messageId = pendingThinking.messageId;
                }
                catch {
                    /* patch failed — fall through to fresh card send */
                }
            }
            if (!messageId) {
                const result = await sender.sendCard(chatId, card, 'chat_id', thread);
                messageId = result?.messageId;
            }
            if (messageId) {
                state.lastId = messageId;
                this.onQuestionnaireRendered?.({ chatId, request: questionnaire, messageId });
                // Questionnaire delivered — revoke the 👀 inbound ack reaction.
                await part.revokeAckReaction();
            }
        }
        catch (err) {
            state.firstError ??= errorMessage(err);
        }
    }
    /** Media refs are sent in order; each failure records the first error only. */
    async sendMediaParts(outbound, sender, thread, state) {
        for (const ref of outbound.media ?? []) {
            try {
                const result = await sender.sendMedia(outbound.ctx.chatId, ref, 'chat_id', thread);
                if (result?.messageId)
                    state.lastId = result.messageId;
            }
            catch (err) {
                state.firstError ??= errorMessage(err);
            }
        }
    }
    /**
     * Tail reply: wrap the text in a Card 2.0 "回复" card (green header,
     * `chat_outlined` icon, `回复` tag) to match the historical
     * `feat/im-genui-full-mr` style. Plain `msg_type: text` would show as a
     * bare text bubble — inconsistent with how Ask user / media render. On an
     * execution failure the pending thinking card is patched in place first so
     * the failure replaces the grey bubble.
     */
    async sendReplyCardPart(part) {
        const { sender, chatId, thread, state } = part;
        try {
            const replyCard = buildReplyCard(part.text);
            let patchedFailureReply = false;
            if (part.executionFailure) {
                patchedFailureReply = await this.patchFailureIntoThinkingCard(sender, chatId, replyCard, state);
            }
            if (!patchedFailureReply) {
                const result = await sender.sendCard(chatId, replyCard, 'chat_id', thread);
                if (result?.messageId)
                    state.lastId = result.messageId;
            }
            // Reply card delivered — revoke the 👀 inbound ack reaction.
            await part.revokeAckReaction();
        }
        catch (err) {
            state.firstError ??= errorMessage(err);
        }
    }
    /** PATCH the failure reply over the grey card; expired cards fall through. */
    async patchFailureIntoThinkingCard(sender, chatId, replyCard, state) {
        const pendingThinking = this.pendingThinkingStore?.get(chatId);
        if (!pendingThinking)
            return false;
        this.pendingThinkingStore?.delete(chatId);
        try {
            await sender.patchCard(pendingThinking.messageId, replyCard);
            state.lastId = pendingThinking.messageId;
            return true;
        }
        catch {
            // The pre-existing card may have expired. Fall through to a
            // thread-aware fresh reply so the failure remains visible.
            return false;
        }
    }
    async resolveQuotedMessageForEnvelope(envelope, record) {
        if (envelope.quotedMessage || !envelope.quotedThreadId) {
            logger.info({
                clientName: this.clientName,
                hasQuoted: !!envelope.quotedMessage,
                quotedThreadId: envelope.quotedThreadId ?? null,
                threadId: envelope.ctx.threadId ?? null,
            }, 'Feishu inbound: no thread to resolve');
            return envelope.quotedMessage;
        }
        return this.resolveQuotedMessageFromRecord(envelope.quotedThreadId, record);
    }
    async resolveQuotedMessageFromRecord(threadId, record) {
        if (!isUsableFeishuBinding(record))
            return undefined;
        try {
            // The inbound event carries a thread id (`omt_…`), not a message id, so
            // the topic root must be fetched via the thread-container listing.
            const snapshot = await this.ensureSender(record).getThreadRootMessage(threadId);
            const quoted = feishuMessageSnapshotToQuotedMessage(snapshot);
            logger.info({
                clientName: this.clientName,
                threadId,
                resolved: !!quoted,
                hasSnapshot: !!snapshot,
            }, 'Feishu quoted context resolved');
            return quoted;
        }
        catch (err) {
            // Best-effort only. Missing `im:message:readonly` or an expired message
            // should not block the user's current inbound turn — but surface it in
            // logs so a permissions gap is diagnosable instead of silently dropped.
            logger.warn({
                clientName: this.clientName,
                threadId,
                status: err?.status,
                err: errorMessage(err),
            }, 'Feishu quoted context lookup failed');
            return undefined;
        }
    }
    async downloadAttachment(input) {
        const record = await this.store.get(this.agentName);
        if (!isUsableFeishuBinding(record)) {
            throw new Error('feishu attachment downloader: binding not configured');
        }
        if (!this.attachmentDownloader) {
            throw new Error('feishu adapter has no attachment downloader configured');
        }
        const filePath = await this.attachmentDownloader({
            messageId: input.messageId ?? input.ref.key,
            fileKey: input.ref.key,
            type: input.ref.type,
            sessionId: input.sessionId ?? input.clientName,
        });
        return { ...input.ref, key: filePath };
    }
    /** Resolve an inbound ref to a local file via the WS-shape downloader. */
    async downloadAttachmentToLocal(input) {
        const record = await this.store.get(this.agentName);
        if (!isUsableFeishuBinding(record)) {
            throw new Error('feishu attachment downloader: binding not configured');
        }
        if (!this.wsAttachmentDownloader)
            throw new Error('feishu adapter: wsAttachmentDownloader not wired');
        if (!input.messageId)
            throw new Error('feishu adapter: messageId required');
        const a = await this.wsAttachmentDownloader({
            messageId: input.messageId,
            ref: input.ref,
            sessionId: input.sessionId ?? input.clientName,
        });
        return {
            type: a.type === 'image' ? 'image' : 'file',
            filePath: a.filePath,
            fileName: a.fileName,
            mimeType: a.mimeType,
        };
    }
    /**
     * Build a {@link FeishuWsAttachmentDownloader} bound to this adapter's
     * sender (lazy, so token cache + retry policy are shared with outbound
     * delivery). `dataDir` is supplied by the host so attachments land under
     * the runtime's data root.
     */
    buildAttachmentDownloader(dataDir) {
        return makeFeishuWsAttachmentDownloader({
            senderProvider: async () => {
                const record = await this.store.get(this.agentName);
                if (!isUsableFeishuBinding(record)) {
                    throw new Error('feishu attachment downloader: binding not configured');
                }
                return this.ensureSender(record);
            },
            dataDir,
        });
    }
    /** Wire a WS-side attachment downloader after construction (host calls this). */
    setWsAttachmentDownloader(downloader) {
        this.wsAttachmentDownloader = downloader;
    }
    async patchCard(messageId, card) {
        const record = await this.store.get(this.agentName);
        if (!isUsableFeishuBinding(record))
            throw new Error('feishu patchCard: not bound');
        await this.ensureSender(record).patchCard(messageId, card);
    }
    /**
     * Render a pending permission ask into the bound Feishu conversation as an
     * interactive Card 2.0 (仅本次允许 / 始终允许 / 拒绝). Consumed by
     * {@link LocalChannelPermissionBridge.onPermissionAsk} via the shared adapter
     * registry.
     *
     * Degrades gracefully:
     *   - A missing, disabled, or mock-mode binding → text-only no-op so a
     *     half-configured agent cannot crash the permission ask path (the
     *     desktop UI still shows the ask; the IM card is best-effort).
     *   - A send failure is swallowed and reported as `{}` — the reply can still
     *     resolve through the UI; only the card is missing.
     *
     * The returned `outboundMessageId` is the Feishu message id of the rendered
     * card. It is also forwarded through {@link onPermissionRendered} so the host
     * can record a `requestId`-keyed pending entry the card-action HTTP handler
     * uses to PATCH the card into its terminal state.
     */
    async renderPermission(input) {
        const record = await this.store.get(this.agentName);
        if (!isUsableFeishuBinding(record)) {
            // Unbound / mock-mode: degrade silently (best-effort IM surface).
            return {};
        }
        const chatId = input.ctx.chatId;
        if (!chatId)
            return {};
        try {
            const card = buildPermissionCard(input.renderable, this.botName);
            // Thread-aware delivery: same anchor resolution as `sendMessage`, so a
            // thread-originated ask renders its card inside the thread instead of
            // the top-level conversation. Non-thread ctx → undefined → unchanged.
            const thread = this.resolveThreadReply(input.ctx);
            const result = await this.ensureSender(record).sendCard(chatId, card, 'chat_id', thread);
            const messageId = result?.messageId;
            if (messageId) {
                this.onPermissionRendered?.({ chatId, renderable: input.renderable, messageId });
                return { outboundMessageId: messageId };
            }
        }
        catch (err) {
            logger.warn({
                err: errorMessage(err),
                requestId: input.renderable.requestId,
                clientName: this.clientName,
            }, 'Feishu permission render failed');
        }
        return {};
    }
    /**
     * Decode a Feishu card-action event as a permission reply for the given
     * pending ask. Returns `null` when the action is not a permission click
     * (`kind !== 'permission_action'` — e.g. a questionnaire submit) or when the
     * decoded `requestId` does not match the pending the caller handed us
     * (requestId isolation — mirrors the Telegram adapter, so a sibling card can
     * never resolve another request). Pure decode with no side effects; the
     * terminal-card PATCH is owned by the card-action HTTP handler.
     */
    async parsePermissionReply(input) {
        const value = extractPermissionActionValue(input.raw);
        if (!value)
            return null;
        if (value.requestId !== input.pending.requestId)
            return null;
        return { behavior: value.behavior };
    }
    /**
     * Start (or restart) the Feishu long connection for this agent.
     *
     * Resolves `true` once the SDK client was DISPATCHED — not when the
     * handshake succeeded: SDK 1.60.0 `WSClient.start()` fires its connect
     * without awaiting it. Callers (`composition/channel-apis.ts`,
     * `restore-platforms.ts` `wsSucceeded`) count dispatches with it; the
     * handshake outcome is tracked in {@link getWsStatus}. `false` means the
     * start was skipped (binding unusable / factory disabled); a throw means
     * dispatch itself failed.
     */
    async startWebSocket(input) {
        // Track the live transport state so status APIs stop echoing only the
        // persisted `connected: true` (which is bind-time, not transport-time).
        const prevStatus = this.ws.status;
        logger.info({ agentName: this.agentName, platform: 'feishu', prevStatus }, 'Feishu WS start attempt');
        // A new attempt starts clean so an error from a previous attempt is
        // never reported as the cause of this one.
        clearFeishuWsError(this.ws);
        this.transitionWs('connecting', 'start_requested');
        const record = await this.readStartableWsRecord();
        if (!record)
            return false;
        const sender = this.ensureSender(record);
        try {
            this.wsClient = await startFeishuEventDispatcher({
                record,
                clientFactory: () => this.ensureWsClient(record),
                normalizeInbound: (data) => this.normalizeInbound({ clientName: this.clientName, raw: data }),
                dispatchInbound: input.dispatchInbound,
                ...(input.preflightInbound ? { preflightInbound: input.preflightInbound } : {}),
                sender,
                ...(this.pendingThinkingStore ? { pendingThinkingStore: this.pendingThinkingStore } : {}),
                ...(this.pendingReactionStore ? { pendingReactionStore: this.pendingReactionStore } : {}),
                ...(this.botName ? { botName: this.botName } : {}),
                ...(this.wsAttachmentDownloader
                    ? { attachmentDownloader: this.wsAttachmentDownloader }
                    : {}),
                ...(input.onCardAction ? { onCardAction: input.onCardAction } : {}),
            });
        }
        catch (err) {
            // Record the failure for `getWsStatus` and re-throw — callers own the
            // error logging (host-channels `startFeishuWs` / `onBindingChanged`).
            this.recordWsStartFailure(err);
            throw err;
        }
        // No status write here on purpose: the SDK logger bridge owns the verdict
        // (`ws connect success` → connected, `connect failed` → error). If it
        // already arrived we keep it; otherwise the status stays `connecting`
        // (or whatever a concurrent teardown set) until the SDK reports.
        logger.info({ agentName: this.agentName, platform: 'feishu', status: this.ws.status }, 'Feishu WS start dispatched');
        return true;
    }
    recordWsStartFailure(err) {
        // Raw text for the status API, safe summary for logs / UI — written
        // together, like every other error write.
        this.ws.lastError = errorMessage(err);
        this.ws.lastErrorSummary = summarizeFeishuSdkMessage([err]);
        this.transitionWs('error', 'start_threw');
        const code = err && typeof err === 'object' ? err.code : undefined;
        logger.error({
            agentName: this.agentName,
            errorName: err instanceof Error ? err.name : typeof err,
            ...(typeof code === 'string' ? { code } : {}),
            platform: 'feishu',
        }, 'Feishu WS transport transition -> error');
    }
    /**
     * Live WS transport state for status/list responses. In-memory only — see
     * {@link FeishuWsStatusInfo} for the state semantics.
     */
    getWsStatus() {
        return describeFeishuWsStatus(this.ws);
    }
    /** Single write path for the WS status: every change is logged with a fixed reason. */
    transitionWs(next, reason) {
        transitionFeishuWsStatus({ state: this.ws, agentName: this.agentName, next, reason });
    }
    /**
     * Tear down cached sender + WS client. Safe to call when nothing is
     * cached (idempotent). Adapters call this on bind / unbind so the next
     * outbound call always mints a fresh transport using the current
     * credentials.
     */
    invalidateTransport() {
        if (this.sender) {
            this.sender.invalidateToken();
        }
        this.sender = undefined;
        this.senderForCredentials = undefined;
        const ws = this.wsClient;
        this.wsClient = undefined;
        const retireSdkBridge = ws ? this.wsBridgeRetirers.get(ws) : undefined;
        // Mark this teardown as intentional. The SDK's own line for it follows
        // as `client_closed_manually` tagged `stale: true`, which tells it apart
        // from a server-side drop (`client_closed`, untagged). `hasSdkBridge` is
        // false for injected factories (no bridge) or when no client existed.
        logger.info({
            clientName: this.clientName,
            agentName: this.agentName,
            hadWsClient: Boolean(ws),
            hasSdkBridge: Boolean(retireSdkBridge),
            prevStatus: this.ws.status,
            reason: 'adapter-invalidate',
        }, 'Feishu WS transport teardown (intentional)');
        // Retire the client's SDK logger bridge BEFORE close(): whatever the SDK
        // still reports for this client afterwards — its own close line, or a
        // first connect close() cannot cancel (see the bridge handle's `retire`)
        // — is logged tagged `stale: true` and can no longer write `this.ws`.
        retireSdkBridge?.();
        // Teardown forgets the previous connection's error along with it.
        clearFeishuWsError(this.ws);
        this.transitionWs('idle', 'adapter_teardown');
        if (ws && typeof ws.close === 'function') {
            // Detached on purpose: teardown must not block the caller on socket IO.
            // The promise is kept on the instance so tests (and a future drain
            // hook) can await the close instead of leaking a floating promise.
            this.wsClosePromise = this.closeWsQuietly(ws);
        }
    }
    async closeWsQuietly(ws) {
        try {
            await ws.close?.();
        }
        catch (err) {
            logger.warn({
                err: errorMessage(err),
                clientName: this.clientName,
                agentName: this.agentName,
            }, 'Feishu WS close failed during teardown');
        }
    }
    /** WS start preconditions: usable binding + factory enabled; logs each skip. */
    async readStartableWsRecord() {
        const record = await this.store.get(this.agentName);
        if (!isUsableFeishuBinding(record)) {
            logger.info({
                agentName: this.agentName,
                platform: 'feishu',
                hasRecord: Boolean(record),
                mode: record?.mode ?? null,
                hasAppId: Boolean(record?.appId),
                hasAppSecret: Boolean(record?.appSecret),
            }, 'Feishu WS start skipped: binding is not usable');
            this.transitionWs('idle', 'start_skipped');
            return undefined;
        }
        if (this.wsClientFactory === false) {
            logger.info({ agentName: this.agentName, platform: 'feishu' }, 'Feishu WS start skipped: factory disabled');
            this.transitionWs('idle', 'start_skipped');
            return undefined;
        }
        return record;
    }
    ensureSender(record) {
        if (!isUsableFeishuBinding(record)) {
            throw new Error('feishu binding is not configured');
        }
        const sig = this.senderForCredentials;
        if (this.sender && sig && sig.appId === record.appId && sig.appSecret === record.appSecret) {
            return this.sender;
        }
        if (this.sender)
            this.sender.invalidateToken();
        this.sender = new FeishuSender(record.appId, record.appSecret, {
            ...this.senderOptions,
            clientName: this.clientName,
        });
        this.senderForCredentials = { appId: record.appId, appSecret: record.appSecret };
        return this.sender;
    }
    async ensureWsClient(record) {
        if (!isUsableFeishuBinding(record)) {
            throw new Error('feishu binding is not configured');
        }
        if (this.wsClient)
            return this.wsClient;
        if (this.wsClientFactory === false) {
            throw new Error('feishu WS client factory is disabled');
        }
        const client = await this.wsClientFactory({
            appId: record.appId,
            appSecret: record.appSecret,
        });
        this.wsClient = client;
        return client;
    }
}
//# sourceMappingURL=feishu-adapter.js.map