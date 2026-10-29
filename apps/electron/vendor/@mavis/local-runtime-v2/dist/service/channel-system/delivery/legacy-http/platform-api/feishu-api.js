/**
 * Feishu legacy HTTP Api (bind / unbind / webhook / status / config-check).
 *
 * Migration copy (MR2): Api half of v1 `channels/feishu.ts`, operating only
 * on v2 channel-system instances. Adaptations:
 * - v2 `LocalFeishuChannelClient` takes an options object (v1 used positional
 *   parameters).
 * - `parseLocalFeishuEvent` returns the structured wire error; mapped back to
 *   the exact v1 400 JSON here.
 */
import { basename as pathBasename } from 'node:path';
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
import { clearOwnerAllConventions } from '../../../binding/storage/owner-store.js';
import { feishuClientId, readFeishuAgentName, } from '../../../transport/feishu/feishu-store.js';
import { isFeishuUrlVerification, parseLocalFeishuEvent, readFeishuVerificationToken, } from '../../../transport/feishu/feishu-events.js';
import { isUsableFeishuBinding } from '../../../transport/feishu/feishu-adapter-utils.js';
import { LocalFeishuChannelClient, } from '../../../transport/feishu/outbound/feishu-outbound-client.js';
import { json, readFirstString, readJsonBody } from '../http-helpers.js';
export class LocalFeishuChannelApi {
    store;
    runner;
    defaultAgentName;
    ownerStore;
    attachmentDownloader;
    onBindingChanged;
    pendingThinkingStore;
    onQuestionnaireRendered;
    quotedMessageResolver;
    botNameResolver;
    onUnbind;
    wsStatusProvider;
    wsTransportGate;
    pendingReactionStore;
    constructor(input) {
        this.store = input.store;
        this.runner = input.runner;
        this.defaultAgentName = input.defaultAgentName;
        this.ownerStore = input.ownerStore;
        this.attachmentDownloader = input.attachmentDownloader;
        this.onBindingChanged = input.onBindingChanged;
        this.pendingThinkingStore = input.pendingThinkingStore;
        this.onQuestionnaireRendered = input.onQuestionnaireRendered;
        this.quotedMessageResolver = input.quotedMessageResolver;
        this.botNameResolver = input.botNameResolver;
        this.onUnbind = input.onUnbind;
        this.wsStatusProvider = input.wsStatusProvider;
        this.wsTransportGate = input.wsTransportGate;
        this.pendingReactionStore = input.pendingReactionStore;
    }
    registerClient(record, senderOptions = {}) {
        if (!isUsableFeishuBinding(record))
            return;
        const agentName = record?.agentName ?? this.defaultAgentName;
        const client = new LocalFeishuChannelClient({
            outboundStore: this.runner.outboundStore,
            store: this.store,
            defaultAgentName: agentName,
            senderOptions,
            ...(this.pendingThinkingStore ? { pendingThinkingStore: this.pendingThinkingStore } : {}),
            ...(this.pendingReactionStore ? { pendingReactionStore: this.pendingReactionStore } : {}),
            ...(this.onQuestionnaireRendered
                ? { onQuestionnaireRendered: this.onQuestionnaireRendered }
                : {}),
            clientName: feishuClientId(agentName),
        });
        this.runner.clients.registerExact(client);
    }
    async statusClients() {
        const clients = {};
        for (const record of await this.store.list()) {
            const resolved = await this.resolveRealBotName(record);
            clients[record.clientId] = serializeFeishuBinding(resolved, this.resolveWsStatus(resolved));
        }
        return clients;
    }
    /**
     * Runtime half of the Connection-list transport gate (the per-record half
     * is `feishuBindingTransport`): false while this process starts no long
     * connection, so no binding may report live WS state. Without a gate from
     * the composition nothing says a long connection runs here → false, like
     * a WeChat / Telegram Api without its status provider. Reads flags only —
     * never an adapter.
     */
    runsWsTransport() {
        return this.wsTransportGate?.() ?? false;
    }
    /**
     * Resolve the live WS transport status for a binding. Non-websocket
     * bindings report `'idle'` (no WS transport by design); a missing provider
     * omits the field entirely.
     */
    resolveWsStatus(record) {
        if (!this.wsStatusProvider)
            return undefined;
        if (record.mode !== 'websocket')
            return { status: 'idle' };
        try {
            return this.wsStatusProvider(record.agentName);
        }
        catch {
            return undefined;
        }
    }
    /**
     * Overlay a binding's real Feishu bot display name onto its stored record
     * for status reporting. Failures are non-fatal: the stored value wins.
     */
    async resolveRealBotName(record) {
        if (!this.botNameResolver || !record.appId || !record.appSecret)
            return record;
        let liveName;
        try {
            liveName = await this.botNameResolver(record);
        }
        catch {
            return record;
        }
        if (!liveName || liveName === record.botName)
            return record;
        return { ...record, botName: liveName };
    }
    async configCheck(agentName) {
        const record = await this.store.get(agentName ?? this.defaultAgentName);
        return {
            configured: Boolean(record?.appId && record.appSecret),
            source: record ? 'local-runtime' : null,
            hasCredentials: Boolean(record?.appId && record.appSecret),
            platform: 'feishu',
            clientId: record?.clientId ?? feishuClientId(agentName ?? this.defaultAgentName),
            localRuntime: true,
            runnerEnabled: true,
        };
    }
    async bind(request) {
        const body = await readJsonBody(request);
        const bound = await this.bindBody(body);
        if ('error' in bound)
            return bound.error;
        return json({
            ok: true,
            ...serializeFeishuBinding(bound.record, this.resolveWsStatus(bound.record)),
        });
    }
    async bindBody(body) {
        const agentName = readFeishuAgentName(body, this.defaultAgentName);
        const appId = readFirstString(body, ['appId', 'app_id']);
        const appSecret = readFirstString(body, ['appSecret', 'app_secret']);
        if (!appId || !appSecret) {
            return {
                error: json({
                    ok: false,
                    error: 'appId and appSecret are required',
                    code: 'VALIDATION_ERROR',
                    localRuntime: true,
                }, { status: 400 }),
            };
        }
        const requestedMode = readFirstString(body, ['mode']);
        if (requestedMode === 'mock')
            return unsupportedMockMode('feishu');
        if (requestedMode && requestedMode !== 'webhook' && requestedMode !== 'websocket') {
            return invalidBindMode('feishu');
        }
        const record = await this.store.bind({
            agentName,
            appId,
            appSecret,
            verificationToken: readFirstString(body, [
                'verificationToken',
                'verification_token',
                'token',
            ]),
            encryptKey: readFirstString(body, [
                'encryptKey',
                'encrypt_key',
                'encryptToken',
                'encrypt_token',
            ]),
            botName: readFirstString(body, ['botName', 'bot_name']),
            mode: requestedMode === 'webhook' ? 'webhook' : 'websocket',
        });
        // Plan §5.2: bind no longer starts its own transport unconditionally. A
        // staged / non-winner record (primary-family loser, or a candidate the
        // reconciler left disabled) must reach neither registry nor the WS start.
        if (record.enabled === false || (await this.store.isPrimaryFamilyAgent(agentName))) {
            logger.info({ agentName, platform: 'feishu' }, 'Feishu bind transport start delegated to family reconciler');
            return { record };
        }
        this.registerClient(record);
        await this.onBindingChanged?.(record);
        return { record };
    }
    async unbind(request) {
        const body = await readJsonBody(request);
        return this.unbindBody(body);
    }
    async hasBindingBody(body) {
        const agentName = readFeishuAgentName(body, this.defaultAgentName);
        return Boolean(await this.store.get(agentName));
    }
    async unbindBody(body) {
        const agentName = readFeishuAgentName(body, this.defaultAgentName);
        // Stop the inbound WS transport BEFORE deleting the store record so an
        // in-flight event cannot land after the binding is gone (proposal §5.4).
        await this.onUnbind?.(agentName);
        const unbound = await this.store.unbind(agentName);
        if (unbound && this.ownerStore) {
            // Clear the owner under BOTH key conventions (daemon-local clientId key
            // and the Electron imGateway `${agentName}:feishu` key) so a re-binding
            // user is not denied with `access-control:owner_only`.
            await clearOwnerAllConventions(this.ownerStore, agentName, 'feishu', feishuClientId(agentName));
        }
        return json({
            ok: true,
            unbound,
            disconnected: unbound,
            platform: 'feishu',
            clientId: feishuClientId(agentName),
            localRuntime: true,
        });
    }
    async handleEvent(request, dispatch, requireBinding = false) {
        const body = await readJsonBody(request);
        if (isFeishuUrlVerification(body)) {
            const gate = requireBinding ? await this.assertBinding(body) : undefined;
            if (gate)
                return gate;
            return json({ challenge: body.challenge, localRuntime: true });
        }
        if (requireBinding) {
            const gate = await this.assertBinding(body);
            if (gate)
                return gate;
        }
        const envelope = parseLocalFeishuEvent(body, this.defaultAgentName);
        if ('error' in envelope)
            return wireValidationResponse(envelope.error);
        if (!dispatch)
            return json({ ok: true, envelope, localRuntime: true });
        return this.dispatchEvent(envelope);
    }
    /**
     * Dispatch tail: resolve attachment refs to local files (best-effort — a
     * failed download marks that attachment with `error: 'download_failed'`
     * but the message still flows) and quoted context, then run the turn.
     */
    async dispatchEvent(envelope) {
        const attachments = await this.resolveAttachments(envelope);
        const quotedMessage = await this.resolveQuotedMessage(envelope);
        return json(await this.runner.dispatchInbound({
            ctx: envelope.ctx,
            text: envelope.text,
            ...(attachments.length > 0 ? { attachments } : {}),
            ...(quotedMessage ? { quotedMessage } : {}),
            ...(envelope.eventId ? { eventId: envelope.eventId } : {}),
        }));
    }
    /**
     * Resolve Feishu attachment refs to local `LocalMessageAttachment` with
     * `filePath` populated. Downloads run concurrently; a single failure does
     * NOT reject the whole batch (failed refs carry `error: 'download_failed'`).
     * When no downloader is configured, returns an empty array.
     */
    async resolveAttachments(envelope) {
        const refs = envelope.attachmentRefs ?? [];
        if (refs.length === 0)
            return [];
        const downloader = this.attachmentDownloader;
        if (!downloader)
            return [];
        const sessionId = envelope.ctx.chatId || envelope.ctx.senderId || 'unknown';
        return Promise.all(refs.map((ref) => resolveOneFeishuAttachment(ref, envelope, sessionId, downloader)));
    }
    async resolveQuotedMessage(envelope) {
        if (envelope.quotedMessage)
            return envelope.quotedMessage;
        if (!envelope.quotedThreadId || !this.quotedMessageResolver)
            return undefined;
        try {
            return await this.quotedMessageResolver({
                threadId: envelope.quotedThreadId,
                envelope,
            });
        }
        catch {
            // Quoted context is helpful but non-critical: never block the inbound
            // turn because Feishu message-history permissions are unavailable.
            return undefined;
        }
    }
    async assertBinding(body) {
        const agentName = readFeishuAgentName(body, this.defaultAgentName);
        const record = await this.store.get(agentName);
        if (!record?.enabled || !record.appId || !record.appSecret) {
            return json({
                ok: false,
                error: 'Feishu binding is not configured',
                code: 'FEISHU_BINDING_REQUIRED',
                platform: 'feishu',
                clientId: feishuClientId(agentName),
                localRuntime: true,
            }, { status: 401 });
        }
        const token = readFeishuVerificationToken(body);
        if (record.verificationToken && token !== record.verificationToken) {
            return json({
                ok: false,
                error: 'Feishu verification token mismatch',
                code: 'FEISHU_VERIFICATION_FAILED',
                platform: 'feishu',
                clientId: record.clientId,
                localRuntime: true,
            }, { status: 401 });
        }
        return undefined;
    }
}
/** Shared shape for every attachment outcome (marker, success, failure). */
function feishuAttachmentBase(ref) {
    return {
        type: ref.type === 'image' ? 'image' : 'file',
        mimeType: ref.mimeType ?? 'application/octet-stream',
    };
}
/** Resolve one Feishu attachment ref; failures degrade to marker records. */
async function resolveOneFeishuAttachment(ref, envelope, sessionId, downloader) {
    if (!ref.key) {
        return {
            ...feishuAttachmentBase(ref),
            filePath: '',
            fileName: ref.name ?? 'attachment',
            dataUrl: undefined,
            assetId: undefined,
            // Missing-attachment marker; downstream layers see the empty
            // filePath and skip the binary read.
        };
    }
    try {
        const filePath = await downloader({
            // §4.5: Feishu resource API is keyed by message_id, NOT event_id.
            // Fall back to eventId only when the parser failed to expose
            // message_id; the resulting 404 is reported via the catch below.
            messageId: envelope.messageId ?? envelope.eventId ?? '',
            fileKey: ref.key,
            type: ref.type,
            sessionId,
        });
        return {
            ...feishuAttachmentBase(ref),
            filePath,
            fileName: ref.name ?? pathBasename(filePath),
        };
    }
    catch {
        return {
            ...feishuAttachmentBase(ref),
            filePath: '',
            fileName: ref.name ?? ref.key ?? 'attachment',
            // Stable failure sentinel (LocalMessageAttachment.error contract).
            error: 'download_failed',
            dataUrl: undefined,
            assetId: undefined,
        };
    }
}
function serializeFeishuBinding(record, 
/**
 * Optional live WS transport status (additive `wsStatus` / `wsLastError`
 * plus the safe `wsLastError*` summary fields).
 */
wsStatus) {
    return {
        ok: true,
        platform: 'feishu',
        clientId: record.clientId,
        agentName: record.agentName,
        appId: record.appId,
        connected: record.connected,
        enabled: record.enabled,
        mode: record.mode,
        appSecretMasked: maskSecret(record.appSecret),
        hasCredentials: Boolean(record.appId && record.appSecret),
        localRuntime: true,
        ...(record.verificationToken
            ? { verificationTokenMasked: maskSecret(record.verificationToken) }
            : {}),
        ...(record.botName ? { botName: record.botName } : {}),
        ...(wsStatus
            ? {
                wsStatus: wsStatus.status,
                ...(wsStatus.lastError ? { wsLastError: wsStatus.lastError } : {}),
                ...serializeWsLastErrorSummary(wsStatus),
            }
            : {}),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
    };
}
/**
 * Additive safe summary of the live WS error. Unlike `wsLastError` (raw SDK
 * text, kept as-is), these hold only a fixed category enum, integers and
 * whitelisted errno tokens, so a client can render them without echoing
 * SDK text. Each field is omitted when unknown.
 */
function serializeWsLastErrorSummary(wsStatus) {
    return {
        ...(wsStatus.lastErrorCategory ? { wsLastErrorCategory: wsStatus.lastErrorCategory } : {}),
        ...(wsStatus.lastErrorCode !== undefined ? { wsLastErrorCode: wsStatus.lastErrorCode } : {}),
        ...(wsStatus.lastErrorCodeName ? { wsLastErrorCodeName: wsStatus.lastErrorCodeName } : {}),
        ...(wsStatus.lastErrorHttpStatus !== undefined
            ? { wsLastErrorHttpStatus: wsStatus.lastErrorHttpStatus }
            : {}),
        ...(wsStatus.lastErrorErrno ? { wsLastErrorErrno: wsStatus.lastErrorErrno } : {}),
        ...(wsStatus.lastErrorRetryCount !== undefined
            ? { wsLastErrorRetryCount: wsStatus.lastErrorRetryCount }
            : {}),
    };
}
/** Maps the v2 structured wire error back to the exact v1 400 JSON shape. */
function wireValidationResponse(error) {
    return json({ error: error.message, code: error.code }, { status: error.status });
}
function unsupportedMockMode(platform) {
    return {
        error: json({
            ok: false,
            error: 'mock channel mode is not supported',
            code: 'CHANNEL_MOCK_MODE_UNSUPPORTED',
            platform,
            localRuntime: true,
        }, { status: 400 }),
    };
}
function invalidBindMode(platform) {
    return {
        error: json({
            ok: false,
            error: 'unsupported channel mode',
            code: 'VALIDATION_ERROR',
            platform,
            localRuntime: true,
        }, { status: 400 }),
    };
}
function maskSecret(secret) {
    if (secret.length <= 6)
        return '***';
    return `${secret.slice(0, 3)}***${secret.slice(-3)}`;
}
//# sourceMappingURL=feishu-api.js.map