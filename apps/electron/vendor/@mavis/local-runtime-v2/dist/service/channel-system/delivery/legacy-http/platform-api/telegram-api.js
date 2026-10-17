/**
 * Telegram legacy HTTP Api (bind / unbind / webhook / status / config-check).
 *
 * Migration copy (MR2): Api half of v1 `channels/telegram.ts`. It operates
 * exclusively on v2 channel-system instances (store / runner / adapter), so
 * the v1 host can delegate its old REST surface here without keeping any
 * store, runner or platform instance of its own. Adaptation: the v2
 * `parseLocalTelegramUpdate` returns a structured wire error instead of a
 * ready-made Response; this facade maps it back to the exact v1 JSON shape.
 */
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
import { clearOwnerAllConventions } from '../../../binding/storage/owner-store.js';
import { isUsableTelegramBinding, telegramClientId, } from '../../../transport/telegram/telegram-store.js';
import { extractTelegramAttachmentRefs, parseLocalTelegramUpdate, } from '../../../transport/telegram/telegram-events.js';
import { TelegramAttachmentDownloader } from '../../../transport/telegram/telegram-attachment-downloader.js';
import { TelegramSender } from '../../../transport/telegram/telegram-sender.js';
import { LocalTelegramChannelClient, } from '../../../transport/telegram/telegram-outbound-client.js';
import { json, readFirstString, readJsonBody } from '../http-helpers.js';
export class LocalTelegramChannelApi {
    store;
    runner;
    defaultAgentName;
    ownerStore;
    options;
    downloaderFactory;
    senderFactory;
    constructor(input) {
        this.store = input.store;
        this.runner = input.runner;
        this.defaultAgentName = input.defaultAgentName;
        this.ownerStore = input.ownerStore;
        const options = input.options ?? {};
        this.options = options;
        const store = input.store;
        this.downloaderFactory =
            options.downloaderFactory ??
                ((factoryInput) => new TelegramAttachmentDownloader({
                    botToken: factoryInput.botToken,
                    dataDir: () => store.getDataDir(),
                    scopeDirName: factoryInput.scopeDirName,
                }));
        this.senderFactory = options.senderFactory ?? ((botToken) => new TelegramSender(botToken));
    }
    registerClient(record) {
        if (!isUsableTelegramBinding(record))
            return;
        const agentName = record?.agentName ?? this.defaultAgentName;
        const adapter = this.options.adapterForAgent?.(agentName) ??
            (agentName === this.defaultAgentName ? this.options.adapter : undefined);
        const client = new LocalTelegramChannelClient(this.runner.outboundStore, this.buildResolveSend(), telegramClientId(agentName), adapter);
        this.runner.clients.registerExact(client);
    }
    /**
     * Resolve the per-agent adapter, creating and registering it in the shared
     * adapter registry as a side effect when the factory is wired. Bind uses this
     * so a never-before-bound agent can register on first bind instead of
     * dead-ending in a 503 that only a prior successful bind could have cleared.
     */
    ensureAdapterForAgent(agentName) {
        return this.options.adapterForAgent?.(agentName) ?? this.options.adapter;
    }
    /**
     * Build the resolver the outbound client uses to obtain a real
     * {@link TelegramSender} for a given context. The agent name is recovered
     * from `ctx.clientName` (`telegram:{agentName}`); real sending requires an
     * enabled, connected SDK binding with a non-empty token — anything else
     * resolves to `null`, which the exact client turns into
     * `CHANNEL_CLIENT_UNAVAILABLE`.
     */
    buildResolveSend() {
        return async (ctx) => {
            const agentName = agentNameFromContext(ctx.clientName, this.defaultAgentName);
            const record = await this.store.get(agentName);
            if (!isUsableTelegramBinding(record))
                return null;
            if (!ctx.chatId)
                return null;
            return { sender: this.senderFactory(record.botToken), chatId: ctx.chatId };
        };
    }
    async statusClients() {
        const clients = {};
        for (const record of await this.store.list()) {
            clients[record.clientId] = serializeTelegramBinding(record);
        }
        return clients;
    }
    async configCheck(agentName) {
        const record = await this.store.get(agentName ?? this.defaultAgentName);
        return {
            configured: Boolean(record?.botToken),
            source: record ? 'local-runtime' : null,
            hasCredentials: Boolean(record?.botToken),
            platform: 'telegram',
            clientId: record?.clientId ?? telegramClientId(agentName ?? this.defaultAgentName),
            localRuntime: true,
            runnerEnabled: true,
        };
    }
    async bind(request) {
        const body = await readJsonBody(request);
        const modeError = validateTelegramBindMode(readFirstString(body, ['mode'])?.toLowerCase());
        if (modeError)
            return modeError;
        const agentName = readFirstString(body, ['agentName', 'agentId', 'agent']) ?? this.defaultAgentName;
        const botToken = readFirstString(body, ['botToken', 'token']);
        if (!botToken) {
            return json({ ok: false, error: 'botToken is required', code: 'VALIDATION_ERROR', localRuntime: true }, { status: 400 });
        }
        const verified = await this.verifyBotToken(botToken);
        if ('error' in verified)
            return verified.error;
        const verifiedBotName = verified.botName;
        const record = await this.store.bind({
            agentName,
            botToken,
            botName: verifiedBotName ?? readFirstString(body, ['botName', 'username', 'botUsername']),
            mode: 'sdk',
        });
        // Plan §5.2: a staged / non-winner record registers no outbound client.
        if (record.enabled === false || (await this.store.isPrimaryFamilyAgent(agentName))) {
            logger.info({ agentName, platform: 'telegram', clientId: record.clientId }, 'Telegram bind transport start delegated to family reconciler');
            return json({ ok: true, ...serializeTelegramBinding(record) });
        }
        this.registerClient(record);
        await this.startBindPoller(agentName, record);
        return json({ ok: true, ...serializeTelegramBinding(record) });
    }
    /**
     * Start the inbound long-poll for the just-bound token; the poller start
     * must live here (single Connection-aware bind ingress) — otherwise a
     * bind succeeds but inbound stays dark until the next process restart.
     * Poller failure is non-fatal by design (proposal §5.4): outbound already
     * works, so the bind response stays 200 and the gap is loud in the logs.
     */
    async startBindPoller(agentName, record) {
        const adapter = this.ensureAdapterForAgent(agentName);
        if (!adapter) {
            // No adapter factory wired (bare-store test fixtures): inbound polling
            // is not available in this configuration, record why for diagnosis.
            logger.warn({ agentName, clientId: record.clientId, source: 'api-bind' }, 'Telegram bind skipped poller start: no adapter factory wired');
            return;
        }
        try {
            const pollerStarted = await adapter.startPoller(record.botToken);
            logger.info({ agentName, clientId: record.clientId, pollerStarted, source: 'api-bind' }, 'Telegram bind inbound poller start attempted');
        }
        catch (err) {
            logger.error({ err, agentName, clientId: record.clientId, source: 'api-bind' }, 'Telegram bind inbound poller start failed');
        }
    }
    /**
     * Validate the token by calling Telegram's getMe endpoint. No silent mock
     * fallback — if Telegram is unreachable, refuse the bind (a "bind ok but
     * mock-only" outcome historically made binds look successful while
     * messages never reached Telegram).
     */
    async verifyBotToken(botToken) {
        const verifyFetch = this.options.tokenVerifyFetcher ?? fetch;
        try {
            const getMeResponse = await verifyFetch(`https://api.telegram.org/bot${botToken}/getMe`);
            const getMeData = (await getMeResponse.json());
            if (!getMeData.ok) {
                return {
                    error: json({
                        ok: false,
                        error: `Invalid bot token: ${getMeData.description ?? 'getMe returned ok=false'}`,
                        code: 'INVALID_BOT_TOKEN',
                        localRuntime: true,
                    }, { status: 400 }),
                };
            }
            const result = getMeData.result;
            // Store just the `@username` handle — that is the only token Telegram
            // ever puts in @mentions / `/command@bot` suffixes, so it is what the
            // mention + command matchers compare against.
            return {
                botName: result?.username ? `@${result.username}` : (result?.first_name ?? undefined),
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
                error: json({
                    ok: false,
                    error: `Failed to verify bot token via Telegram getMe: ${msg}`,
                    code: 'TELEGRAM_VERIFY_UNREACHABLE',
                    localRuntime: true,
                }, { status: 502 }),
            };
        }
    }
    async unbind(request) {
        const body = await readJsonBody(request);
        const agentName = readFirstString(body, ['agentName', 'agentId', 'agent']) ?? this.defaultAgentName;
        // Stop the inbound long-poll BEFORE deleting the store record so an
        // in-flight `getUpdates` result cannot dispatch after the binding is
        // gone (proposal §5.4). Scoped strictly to this agentName so a sibling
        // agent's poller is never touched.
        if (this.options.onUnbind)
            await this.options.onUnbind(agentName);
        else
            this.options.adapterForAgent?.(agentName)?.shutdown();
        const unbound = await this.store.unbind(agentName);
        // Drop the recorded owner so the next DM after re-bind can claim
        // ownership. Best-effort: a missing owner record is not an error.
        if (unbound && this.ownerStore) {
            await clearOwnerAllConventions(this.ownerStore, agentName, 'telegram', telegramClientId(agentName));
        }
        return json({
            ok: true,
            unbound,
            platform: 'telegram',
            clientId: telegramClientId(agentName),
            localRuntime: true,
        });
    }
    async handleUpdate(request, dispatch, requireBinding = false) {
        const body = await readJsonBody(request);
        if (requireBinding) {
            const gate = await this.assertBinding(body);
            if (gate)
                return gate;
        }
        const envelope = parseLocalTelegramUpdate(body, this.defaultAgentName);
        if ('error' in envelope)
            return wireValidationResponse(envelope.error);
        if (!dispatch)
            return json({ ok: true, envelope, localRuntime: true });
        return this.dispatchUpdate(body, envelope);
    }
    /** Dispatch tail: resolve attachments (if any) then run the inbound turn. */
    async dispatchUpdate(body, envelope) {
        let attachments;
        if (envelope.attachmentRefs.length > 0) {
            attachments = await this.downloadAttachments(body, envelope);
        }
        return json(await this.runner.dispatchInbound({
            ctx: envelope.ctx,
            text: envelope.text,
            ...(attachments && attachments.length > 0 ? { attachments } : {}),
            ...(envelope.eventId ? { eventId: envelope.eventId } : {}),
        }));
    }
    /** Reject an inbound webhook when the addressed agent has no usable binding. */
    async assertBinding(body) {
        const agentName = readFirstString(body, ['agentName', 'agentId', 'agent']) ?? this.defaultAgentName;
        const record = await this.store.get(agentName);
        if (!record?.enabled || !record.botToken) {
            return json({
                ok: false,
                error: 'Telegram binding is not configured',
                code: 'TELEGRAM_BINDING_REQUIRED',
                platform: 'telegram',
                clientId: telegramClientId(agentName),
                localRuntime: true,
            }, { status: 401 });
        }
        return undefined;
    }
    /**
     * Download every attachment referenced by `envelope.attachmentRefs` using
     * the bound bot token. Failures degrade gracefully — a single broken
     * download does NOT block the parent message. The downloader is created
     * lazily per request so the bot token is read from the persisted binding
     * at call time; tests inject a stubbed factory.
     */
    async downloadAttachments(body, envelope) {
        const agentName = readFirstString(body, ['agentName', 'agentId', 'agent']) ?? this.defaultAgentName;
        const record = await this.store.get(agentName);
        if (!record?.botToken) {
            // No token — degrade to text-only. The earlier `requireBinding` gate
            // already rejected requests without a binding when one was required,
            // so this branch only fires for an ungated local dispatch path.
            return [];
        }
        const downloader = this.downloaderFactory({
            botToken: record.botToken,
            scopeDirName: envelope.ctx.clientName,
        });
        const items = extractTelegramAttachmentRefs(findTelegramMessage(body));
        if (items.length === 0)
            return [];
        return downloader.downloadAll(items);
    }
}
/** Shared bind-mode gate: only `sdk` (or unset) is a real Telegram bind. */
function validateTelegramBindMode(requestedMode) {
    if (requestedMode === 'mock') {
        return json({
            ok: false,
            error: 'mock channel mode is not supported',
            code: 'CHANNEL_MOCK_MODE_UNSUPPORTED',
            platform: 'telegram',
            localRuntime: true,
        }, { status: 400 });
    }
    if (requestedMode && requestedMode !== 'sdk') {
        return json({
            ok: false,
            error: 'unsupported channel mode',
            code: 'VALIDATION_ERROR',
            platform: 'telegram',
            localRuntime: true,
        }, { status: 400 });
    }
    return undefined;
}
/** Maps the v2 structured wire error back to the exact v1 400 JSON shape. */
function wireValidationResponse(error) {
    return json({ error: error.message, code: error.code }, { status: error.status });
}
function serializeTelegramBinding(record) {
    return {
        ok: true,
        platform: 'telegram',
        clientId: record.clientId,
        agentName: record.agentName,
        connected: record.connected,
        enabled: record.enabled,
        mode: record.mode,
        tokenMasked: maskToken(record.botToken),
        hasCredentials: Boolean(record.botToken),
        localRuntime: true,
        ...(record.botName ? { botName: record.botName } : {}),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
    };
}
/**
 * Recover the agent name from an outbound context clientName
 * (`telegram:{agentName}`); falls back to the channel default.
 */
function agentNameFromContext(clientName, defaultAgentName) {
    const trimmed = clientName?.trim();
    if (trimmed) {
        const withoutPrefix = trimmed.startsWith('telegram:')
            ? trimmed.slice('telegram:'.length)
            : trimmed;
        if (withoutPrefix.trim())
            return withoutPrefix.trim();
    }
    return defaultAgentName;
}
function maskToken(token) {
    if (token.length <= 6)
        return '***';
    return `${token.slice(0, 3)}***${token.slice(-3)}`;
}
/**
 * Locate the inbound Telegram message inside a webhook body. Mirrors the
 * `parseLocalTelegramUpdate` traversal so the downloader sees the same
 * payload structure the parser used to populate `attachmentRefs`.
 */
function findTelegramMessage(body) {
    const rawUpdate = isRecord(body.update) ? body.update : body;
    return firstRecord(rawUpdate, ['message', 'edited_message', 'channel_post']) ?? {};
}
function firstRecord(raw, keys) {
    for (const key of keys) {
        if (isRecord(raw[key]))
            return raw[key];
    }
    return undefined;
}
function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
//# sourceMappingURL=telegram-api.js.map