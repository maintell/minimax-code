/**
 * Three-platform channel Api assembly against one shared runner.
 *
 * Migration copy (MR2): the `createChannelApis` half of v1
 * `api/host-channels.ts`. Every store/adapter/client constructed here is a v2
 * channel-system instance; the returned Api objects are the single business
 * owners the legacy HTTP facade delegates to. §5.6 lazy-registration
 * semantics (no construction-time default-agent transport edges) are kept
 * verbatim.
 */
import { LocalChannelRunner } from '../ingress/runner.js';
import { LocalChannelOwnerStore } from '../binding/storage/owner-store.js';
import { LocalAccessControlStore } from '../access-control/access-control-store.js';
import { LocalFeishuChannelStore, feishuClientId, } from '../transport/feishu/feishu-store.js';
import { LocalFeishuChannelApi } from '../delivery/legacy-http/platform-api/feishu-api.js';
import { LocalFeishuChannelClient } from '../transport/feishu/outbound/feishu-outbound-client.js';
import { FeishuPlatformAdapter } from '../transport/feishu/feishu-adapter.js';
import { LocalTelegramChannelStore, telegramClientId, } from '../transport/telegram/telegram-store.js';
import { LocalTelegramChannelApi } from '../delivery/legacy-http/platform-api/telegram-api.js';
import { TelegramPlatformAdapter } from '../transport/telegram/telegram-adapter.js';
import { TelegramAttachmentDownloader } from '../transport/telegram/telegram-attachment-downloader.js';
import { TelegramSender } from '../transport/telegram/telegram-sender.js';
import { LocalWeChatChannelStore, wechatClientId } from '../transport/wechat/wechat-store.js';
import { LocalWeChatChannelApi } from '../delivery/legacy-http/platform-api/wechat-api.js';
import { LocalWeChatChannelClient } from '../transport/wechat/wechat-outbound-client.js';
import { LocalWeChatChannelAdapter } from '../transport/wechat/wechat-adapter.js';
import { stubWeChatRuntimeSdk } from '../transport/wechat/wechat-sdk-stub.js';
import { restoreInboundLoops } from './restore.js';
import { detach } from '../settle.js';
import { IDLE_CHANNEL_TRANSPORT, } from '../ingress/channel-transport-status.js';
import { AgentContractHttpError } from '../delivery/legacy-http/agent-contract-error.js';
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
/** WS dispatch surface shared by restore, bind-time and binding-changed starts. */
function buildFeishuWsInputFactory(input) {
    return () => ({
        dispatchInbound: (message) => input.runner.dispatchInbound(message),
        ...(input.preflightInbound ? { preflightInbound: input.preflightInbound } : {}),
        // Route Feishu Card 2.0 form submissions (questionnaire) through the same
        // `feishuCardActionHandler` that the public webhook uses.
        onCardAction: async (data) => {
            const handler = input.cardActionHandlerProvider?.();
            if (!handler)
                return {};
            const resp = await handler((data ?? {}));
            try {
                const body = await resp.json();
                if (body && typeof body === 'object' && 'toast' in body)
                    return body;
            }
            catch {
                /* not JSON or already consumed — fall through */
            }
            return {};
        },
    });
}
/** Webhook-facing downloader + quoted/bot-name resolvers over the adapter map. */
function buildFeishuResolvers(input, feishuAdapter, getOrCreateFeishuAdapter) {
    const defaultFeishuDownloader = feishuAdapter.buildAttachmentDownloader(input.dataDir);
    const feishuWebhookDownloader = async ({ messageId, fileKey, type, sessionId }) => {
        const a = await defaultFeishuDownloader({
            messageId,
            ref: { type, key: fileKey },
            sessionId,
        });
        return a.filePath;
    };
    const feishuWebhookQuotedMessageResolver = async ({ threadId, envelope, }) => getOrCreateFeishuAdapter(envelope.ctx.clientName || input.agentName).resolveQuotedMessageByThreadId(threadId);
    const feishuBotNameResolver = async (record) => getOrCreateFeishuAdapter(record.agentName || input.agentName).resolveBotName(record);
    return { feishuWebhookDownloader, feishuWebhookQuotedMessageResolver, feishuBotNameResolver };
}
/**
 * Feishu arm: store, pending maps, adapter factory, WS start entrypoints and
 * the legacy Api instance. Extracted verbatim from the single v1
 * `createChannelApis` body (v2 lint size budget).
 */
function buildFeishuArm(input) {
    const channelFetch = input.fetchImpl;
    const makeFeishuWsInput = buildFeishuWsInputFactory(input);
    const feishuSenderOptions = channelFetch ? { fetcher: channelFetch } : {};
    const feishuStore = input.stores.feishu ?? new LocalFeishuChannelStore(input.dataDir, input.nowMs);
    const feishuWsEnabled = input.feishuWsEnabled !== false;
    // Adapters get a WS client factory only with the WS transport on and a
    // registry; without one `startWebSocket` skips. Shared with the
    // Connection-list gate below so the two can never disagree.
    const feishuWsClientsEnabled = feishuWsEnabled && input.adapterRegistry !== undefined;
    const feishuPendingQuestionnaires = new Map();
    const feishuPendingPermissions = new Map();
    // Shared per-chat map of "🤔 思考中…" cards the WS dispatcher renders so
    // the outbound client can PATCH them into the final green reply card.
    const feishuPendingThinkingCards = new Map();
    // Shared per-inbound-message map of 👀 `OnIt` ack reactions the WS
    // dispatcher posts so the outbound side can revoke them once the final
    // reply has been delivered.
    const feishuPendingReactions = new Map();
    const registerFeishuClient = (record) => {
        const agentName = record?.agentName ?? input.agentName;
        // v2 adaptation: the outbound client takes an options object.
        const client = new LocalFeishuChannelClient({
            outboundStore: input.runner.outboundStore,
            store: feishuStore,
            defaultAgentName: agentName,
            senderOptions: feishuSenderOptions,
            pendingThinkingStore: feishuPendingThinkingCards,
            pendingReactionStore: feishuPendingReactions,
            onQuestionnaireRendered: ({ chatId, request, messageId }) => {
                feishuPendingQuestionnaires.set(request.id, {
                    request,
                    clientName: feishuClientId(agentName),
                    chatId,
                    messageId,
                    createdAtMs: input.nowMs(),
                });
                logger.info({ requestId: request.id, messageId, source: 'adapter' }, 'Feishu questionnaire rendered');
            },
            clientName: feishuClientId(agentName),
        });
        if (!record || !record.enabled || record.mode === 'mock')
            return;
        input.runner.clients.registerExact(client);
    };
    const feishuAdapters = new Map();
    const unregisterFeishuEdge = (agentName) => {
        const clientId = feishuClientId(agentName);
        feishuAdapters.get(clientId)?.invalidateTransport();
        input.runner.clients.unregister(clientId);
        input.adapterRegistry?.unregister('feishu', clientId);
    };
    const getOrCreateFeishuAdapter = (agentName, options) => {
        const clientName = feishuClientId(agentName);
        const register = options?.register !== false;
        const existing = feishuAdapters.get(clientName);
        if (existing) {
            // Re-registering an existing instance is a Map write, so a lazily
            // constructed adapter still lands in the registry the first time an
            // enabled record (restore) or a bind asks for it.
            if (register)
                input.adapterRegistry?.register(existing);
            return existing;
        }
        const adapter = new FeishuPlatformAdapter({ store: feishuStore, agentName }, {
            wsClientFactory: feishuWsClientsEnabled ? undefined : false,
            pendingThinkingStore: feishuPendingThinkingCards,
            pendingReactionStore: feishuPendingReactions,
            senderOptions: feishuSenderOptions,
            onBindingChanged: (record) => {
                registerFeishuClient(record);
                if (record.mode === 'websocket') {
                    // Fire-and-forget on purpose (bind must not block on the WS
                    // handshake), but never silently: log attempt / outcome so a
                    // failed connect is diagnosable instead of "bound but deaf".
                    logger.info({ agentName: record.agentName, platform: 'feishu' }, 'Feishu WS start requested (binding changed)');
                    detach(startBindingChangedFeishuWs(record.agentName));
                }
            },
            onQuestionnaireRendered: ({ chatId, request, messageId }) => {
                feishuPendingQuestionnaires.set(request.id, {
                    request,
                    clientName,
                    chatId,
                    messageId,
                    createdAtMs: input.nowMs(),
                });
                logger.info({ requestId: request.id, messageId, source: 'adapter' }, 'Feishu questionnaire rendered');
            },
            onPermissionRendered: ({ chatId, renderable, messageId }) => {
                feishuPendingPermissions.set(renderable.requestId, {
                    renderable,
                    clientName,
                    chatId,
                    messageId,
                    createdAtMs: input.nowMs(),
                });
                logger.info({ requestId: renderable.requestId, messageId, source: 'adapter' }, 'Feishu permission rendered');
            },
        });
        const wsDownloader = adapter.buildAttachmentDownloader(input.dataDir);
        adapter.setWsAttachmentDownloader(wsDownloader);
        feishuAdapters.set(clientName, adapter);
        if (register)
            input.adapterRegistry?.register(adapter);
        return adapter;
    };
    const startBindingChangedFeishuWs = async (agentName) => {
        try {
            const started = await getOrCreateFeishuAdapter(agentName).startWebSocket(makeFeishuWsInput());
            logger.info({ agentName, started, platform: 'feishu' }, 'Feishu WS start finished (binding changed)');
        }
        catch (err) {
            logger.error({ err, agentName, platform: 'feishu' }, 'Feishu WS start failed (binding changed)');
        }
    };
    // Construct the default-agent adapter WITHOUT registering it: §5.6 forbids
    // pre-registering a transport edge for the default agentName when no enabled
    // record has been seen yet. Restore (enabled record) and bind register it.
    const feishuAdapter = getOrCreateFeishuAdapter(input.agentName, { register: false });
    const { feishuWebhookDownloader, feishuWebhookQuotedMessageResolver, feishuBotNameResolver } = buildFeishuResolvers(input, feishuAdapter, getOrCreateFeishuAdapter);
    const startFeishuWs = async (agentName = input.agentName) => {
        if (!feishuWsEnabled) {
            logger.info({ agentName, platform: 'feishu' }, 'Feishu WS start skipped: ws disabled');
            return false;
        }
        logger.info({ agentName, platform: 'feishu' }, 'Feishu WS start requested');
        const started = await getOrCreateFeishuAdapter(agentName).startWebSocket(makeFeishuWsInput());
        logger.info({ agentName, started, platform: 'feishu' }, 'Feishu WS start finished');
        return started;
    };
    const startBindTimeFeishuWs = async (agentName) => {
        try {
            await startFeishuWs(agentName);
        }
        catch (err) {
            const code = err && typeof err === 'object' ? err.code : undefined;
            logger.error({
                agentName,
                errorName: err instanceof Error ? err.name : typeof err,
                ...(typeof code === 'string' ? { code } : {}),
                platform: 'feishu',
            }, 'Feishu bind WS start failed');
        }
    };
    const feishu = new LocalFeishuChannelApi({
        store: feishuStore,
        runner: input.runner,
        defaultAgentName: input.agentName,
        ownerStore: input.ownerStore,
        attachmentDownloader: feishuWebhookDownloader,
        onBindingChanged: (record) => {
            // The legacy API owns the bind ingress, while this host owns the
            // concrete SDK/fetch wiring. Re-register the exact edge here so a
            // successful rebind cannot retain the API's unconfigured direct client
            // (and test injection follows the same production path).
            registerFeishuClient(record);
            detach(startBindTimeFeishuWs(record.agentName));
        },
        pendingThinkingStore: feishuPendingThinkingCards,
        onQuestionnaireRendered: ({ chatId, request, messageId, clientName }) => {
            feishuPendingQuestionnaires.set(request.id, {
                request,
                clientName,
                chatId,
                messageId,
                createdAtMs: input.nowMs(),
            });
            logger.info({ requestId: request.id, messageId, source: 'client' }, 'Feishu questionnaire rendered');
        },
        quotedMessageResolver: feishuWebhookQuotedMessageResolver,
        botNameResolver: feishuBotNameResolver,
        // Every exact unbind removes its live adapter + exact runner edge. Do not
        // create an adapter here: a missing adapter is already fully unbound.
        onUnbind: unregisterFeishuEdge,
        // Live WS transport status provider — mirrors the teardown hook above:
        // resolved per concrete agentName so status/list can report *this*
        // binding's in-memory `wsStatus` instead of only the persisted record.
        wsStatusProvider: (agentName) => getOrCreateFeishuAdapter(agentName).getWsStatus(),
        // Runtime half of the Connection-list gate (the record half is
        // `feishuBindingTransport`), like `liveTransportStatus` for WeChat /
        // Telegram: a quarantined startup starts no long connection (restore
        // pass and winner start), nor does a runtime without WS clients
        // (`startFeishuWs`, `wsClientFactory`). Reads flags only, never an
        // adapter, and leaves `statusClients()` untouched.
        wsTransportGate: () => input.restoreInboundLoops !== false && feishuWsClientsEnabled,
        // Shared pending 👀 ack-reaction store so clients registered by the API
        // itself (bind-time re-registration) also revoke the ack on delivery.
        pendingReactionStore: feishuPendingReactions,
    });
    return {
        feishuStore,
        feishuWsEnabled,
        feishuPendingQuestionnaires,
        feishuPendingPermissions,
        feishuPendingThinkingCards,
        feishuPendingReactions,
        registerFeishuClient,
        unregisterFeishuEdge,
        getOrCreateFeishuAdapter,
        feishuAdapter,
        startFeishuWs,
        feishu,
    };
}
/**
 * Live receive-channel state of one WeChat / Telegram agent for the
 * Connection list and the legacy status overlay. Read-only on purpose: a
 * status read must never construct (and thereby register) an adapter.
 *   - quarantined startup: copied bindings never start loops → report nothing;
 *   - an adapter exists: its own answer (`undefined` when inbound is unwired);
 *   - no adapter yet: nothing was started for this agent in this process →
 *     `idle` (or nothing when this runtime cannot run the channel at all).
 */
function liveTransportStatus(scope) {
    if (scope.quarantined)
        return undefined;
    if (scope.adapter)
        return scope.adapter.inboundTransportStatus();
    return scope.inboundWired ? IDLE_CHANNEL_TRANSPORT : undefined;
}
/**
 * Telegram arm: shared store, per-agent adapter factory and the legacy Api.
 * Extracted verbatim from the v1 `createChannelApis` body.
 */
function buildTelegramArm(input) {
    const channelFetch = input.fetchImpl;
    // MR-B: hoist the Telegram store so the legacy `LocalTelegramChannelApi`
    // and the new unified `TelegramPlatformAdapter` share a single binding
    // source of truth. Reaching into `LocalTelegramChannelApi['store']` is
    // intentionally avoided — `store` is a private field.
    const telegramStore = input.stores.telegram ?? new LocalTelegramChannelStore(input.dataDir, input.nowMs);
    const telegramAdapters = new Map();
    const unregisterTelegramEdge = (agentName) => {
        const clientId = telegramClientId(agentName);
        telegramAdapters.get(clientId)?.shutdown();
        input.runner.clients.unregister(clientId);
        input.adapterRegistry?.unregister('telegram', clientId);
    };
    let telegramApi;
    const createTelegramSender = channelFetch === undefined
        ? undefined
        : (botToken) => new TelegramSender(botToken, { fetcher: channelFetch });
    const createTelegramDownloader = channelFetch === undefined
        ? undefined
        : (downloaderInput) => new TelegramAttachmentDownloader({
            botToken: downloaderInput.botToken,
            dataDir: () => telegramStore.getDataDir(),
            scopeDirName: downloaderInput.scopeDirName,
            fetcher: channelFetch,
        });
    const getOrCreateTelegramAdapter = (agentName, options) => {
        const clientName = telegramClientId(agentName);
        const register = options?.register !== false;
        const existing = telegramAdapters.get(clientName);
        if (existing) {
            if (register)
                input.adapterRegistry?.register(existing);
            return existing;
        }
        const adapter = new TelegramPlatformAdapter({
            store: telegramStore,
            defaultAgentName: agentName,
            clientName,
            ownerStore: input.ownerStore,
            onUnbind: unregisterTelegramEdge,
            // Bind the runner so bind() can start the Bot API long-poll and
            // every inbound `Update` flows into runner.dispatchInbound. Without
            // this the adapter's `startPollerBestEffort` no-ops on the missing
            // dispatcher and Telegram inbound stays dark in production.
            dispatchInbound: (message) => input.runner.dispatchInbound(message),
            onBindingChanged: (record) => telegramApi?.registerClient(record),
            ...(input.telegramTokenVerifyFetcher || channelFetch
                ? { tokenVerifyFetcher: input.telegramTokenVerifyFetcher ?? channelFetch }
                : {}),
            ...(createTelegramSender ? { senderFactory: createTelegramSender } : {}),
            ...(createTelegramDownloader ? { downloaderFactory: createTelegramDownloader } : {}),
            ...(channelFetch ? { pollerFetcher: channelFetch } : {}),
        });
        telegramAdapters.set(clientName, adapter);
        if (register)
            input.adapterRegistry?.register(adapter);
        // First-time creation of a per-agent Telegram adapter — the only place one
        // lands in the shared registry. Covers all three registration paths
        // (startup eager for the default agent, restore of an already-bound agent,
        // and first-bind self-heal via `ensureAdapterForAgent`) so "was this
        // agent's adapter ever registered, and when" is answerable from logs.
        // Fires exactly once per clientName — the cache-hit branch above returns
        // early, so a miss that still leaves the registry short would show up as a
        // single registration line followed by repeated `source:'ensured'` binds.
        logger.info({
            agentName,
            clientName,
            registered: register,
            registeredCount: input.adapterRegistry?.list('telegram').length,
        }, 'Telegram adapter created and registered');
        return adapter;
    };
    // Create the unified adapter FIRST so the legacy outbound client can delegate
    // questionnaire delivery to it. Pending asks are recorded on this instance
    // and the SAME instance is registered in the adapter registry, so outbound
    // questionnaire rendering and inbound callback_query decoding share one
    // `pendingByChat` — mirrors the WeChat adapter wiring. Newer dev also keeps
    // one adapter per bound agent; the legacy client resolves the matching
    // per-agent adapter via `adapterForAgent` below.
    const telegramAdapter = getOrCreateTelegramAdapter(input.agentName, { register: false });
    const telegram = new LocalTelegramChannelApi({
        store: telegramStore,
        runner: input.runner,
        defaultAgentName: input.agentName,
        ownerStore: input.ownerStore,
        options: {
            adapter: telegramAdapter,
            adapterForAgent: getOrCreateTelegramAdapter,
            onUnbind: unregisterTelegramEdge,
            // Every adapter built here gets `dispatchInbound`, so the channel is
            // wired whenever startup is not quarantined.
            transportStatusProvider: (agentName) => liveTransportStatus({
                quarantined: input.restoreInboundLoops === false,
                adapter: telegramAdapters.get(telegramClientId(agentName)),
                inboundWired: true,
            }),
            ...(input.telegramTokenVerifyFetcher || channelFetch
                ? { tokenVerifyFetcher: input.telegramTokenVerifyFetcher ?? channelFetch }
                : {}),
            ...(createTelegramSender ? { senderFactory: createTelegramSender } : {}),
            ...(createTelegramDownloader ? { downloaderFactory: createTelegramDownloader } : {}),
        },
    });
    telegramApi = telegram;
    return {
        telegramStore,
        getOrCreateTelegramAdapter,
        telegramAdapter,
        telegram,
        unregisterTelegramEdge,
    };
}
/**
 * WeChat arm: store, adapter factory + registry edges and the legacy Api.
 * Extracted verbatim from the v1 `createChannelApis` body.
 */
function buildWeChatArm(input) {
    const channelFetch = input.fetchImpl;
    const wechatStore = input.stores.wechat ?? new LocalWeChatChannelStore(input.dataDir, input.nowMs);
    const wechatSdk = input.wechatRuntimeSdk ?? stubWeChatRuntimeSdk;
    const wechatAdapters = new Map();
    const registerWeChatEdge = (adapter) => {
        input.adapterRegistry?.register(adapter);
        input.runner.clients.registerExact(new LocalWeChatChannelClient(input.runner.outboundStore, adapter));
    };
    const getOrCreateWeChatAdapter = (agentName, options) => {
        const clientName = wechatClientId(agentName);
        const register = options?.register !== false;
        const existing = wechatAdapters.get(clientName);
        if (existing) {
            if (register)
                registerWeChatEdge(existing);
            return existing;
        }
        const adapter = new LocalWeChatChannelAdapter({
            clientName,
            agentName,
            store: wechatStore,
            runner: input.runner,
            sdk: wechatSdk,
        });
        wechatAdapters.set(clientName, adapter);
        if (register)
            registerWeChatEdge(adapter);
        return adapter;
    };
    // Constructed lazily per bound agent (§5.6): no default-agent adapter is
    // created or registered at construction time.
    const wechat = new LocalWeChatChannelApi({
        store: wechatStore,
        runner: input.runner,
        defaultAgentName: input.agentName,
        makeId: input.makeId,
        ownerStore: input.ownerStore,
        onboardFetch: input.wechatOnboardFetcher ?? channelFetch,
        // Start the iLink monitor the instant the user finishes scanning. If it
        // cannot start, remove the just-created exact edge and surface the stable
        // 503 contract instead of reporting a bound-but-dark channel.
        onBindFinalised: async (agentName) => {
            const clientId = wechatClientId(agentName);
            const adapter = getOrCreateWeChatAdapter(agentName);
            try {
                await adapter.ensureMonitorRunning();
            }
            catch {
                // A real QR credential without a running monitor is not a bound
                // channel. Persist the rollback before removing its runtime edges so
                // a later startBind cannot short-circuit it as confirmed.
                await wechatStore.setEnabled(agentName, false);
                adapter.shutdown();
                input.runner.clients.unregister(clientId);
                input.adapterRegistry?.unregister('wechat', clientId);
                throw new AgentContractHttpError(503, 'Channel transport could not be started', 'CHANNEL_START_FAILED');
            }
        },
        // Live health probe: status reflects iLink long-poll health, not just binding existence.
        monitorHealthProvider: (agentName) => wechatAdapters.get(wechatClientId(agentName))?.monitorHealth(),
        transportStatusProvider: (agentName) => liveTransportStatus({
            quarantined: input.restoreInboundLoops === false,
            adapter: wechatAdapters.get(wechatClientId(agentName)),
            inboundWired: Boolean(wechatSdk.createMonitor),
        }),
        // Tear down the exact runtime edge before deleting its binding. Family
        // cleanup also unregisters its winner/legacy edge, but a regular exact
        // unbind does not go through that reconciler path. Leaving the client in
        // either registry made a same-name rebind look successful while outbound
        // still targeted the stale adapter.
        onUnbind: (agentName) => {
            const clientId = wechatClientId(agentName);
            wechatAdapters.get(clientId)?.shutdown();
            input.runner.clients.unregister(clientId);
            input.adapterRegistry?.unregister('wechat', clientId);
        },
    });
    return { wechatStore, wechatAdapters, getOrCreateWeChatAdapter, wechat };
}
export function createChannelApis(input) {
    const feishuArm = buildFeishuArm(input);
    const { feishuStore, feishuPendingQuestionnaires, feishuPendingPermissions, registerFeishuClient, getOrCreateFeishuAdapter, feishuAdapter, startFeishuWs, feishu, } = feishuArm;
    // NOTE: `feishu.registerClient()` used to run here for the default agentName.
    // §5.6 makes outbound client registration lazy: an enabled persisted record
    // registers its exact client through `restoreInboundLoops`, and a fresh bind
    // registers through `onBindingChanged` / the API's own `registerClient`.
    // Pre-registering for `input.agentName` would keep a client alive for an
    // agent whose credential is disabled (or whose family lost the winner).
    // NOTE: eager `void startFeishuWs()` used to sit here as the primary boot
    // path, hardcoded to `input.agentName` (usually the default agent — e.g.
    // `mavis`). It was made redundant once `restartInboundLoops()` below
    // was introduced: restore now enumerates every persisted binding and
    // dispatches `startFeishuWs(record.agentName)` per record — including
    // agents whose name differs from `input.agentName` (e.g. a user with
    // `agentName: main` on disk). Keeping the eager call around made two
    // things worse:
    //   1. When `input.agentName` didn't match any bound agentName it would
    //      produce a misleading `Feishu WS start skipped {hasRecord:false}`
    //      log line even though the store DID have a valid binding under a
    //      different agentName, muddying diagnostics of "why didn't WS start".
    //   2. When it DID match, restore would re-fire the same request in the
    //      same tick — idempotent (the adapter dedups), but it also created
    //      a phantom `feishu:<input.agentName>` adapter for the mismatched
    //      case, which stays live in the adapter map with no owning binding.
    // Restore is now the sole entrypoint; bind-time uses `onBindingChanged`,
    // desktop-restart uses `restartInboundLoops`. See fix/feishu-store-load-race.
    const telegramArm = buildTelegramArm(input);
    const { telegramStore, getOrCreateTelegramAdapter, telegram } = telegramArm;
    // §5.6: no construction-time `telegram.registerClient()` for the default
    // agentName. The exact client is registered by restore (enabled record) or
    // by bind (`onBindingChanged`), never speculatively.
    const wechatArm = buildWeChatArm(input);
    const { wechatStore, getOrCreateWeChatAdapter, wechat } = wechatArm;
    // §5.6: the default adapter is NOT wired into an outbound client here.
    // `wechat.registerClient(adapter)` used to run at construction for
    // `input.agentName`; a disabled or non-winner record would then keep a live
    // outbound edge. Restore registers the exact client for every enabled record,
    // and `ensureMonitorRunning` does the same right after a successful scan.
    // Restore exact clients for every already-bound agent, then resume inbound
    // loops only when startup execution permits it. A quarantined clone still
    // needs correct per-agent outbound routing, but copied bindings must not
    // restart WS, pollers, or monitors.
    const runRestoreInboundLoops = () => restoreInboundLoops({
        feishuStore,
        telegramStore,
        wechatStore,
        registerFeishuClient,
        registerTelegramClient: (record) => telegram.registerClient(record),
        startFeishuWs,
        getOrCreateFeishuAdapter,
        getOrCreateTelegramAdapter,
        getOrCreateWeChatAdapter,
        startInboundLoops: input.restoreInboundLoops !== false,
        clientRegistry: input.runner.clients,
        ...(input.adapterRegistry ? { adapterRegistry: input.adapterRegistry } : {}),
        ...(input.resolveAgentReadScope
            ? { resolveAgentReadScope: input.resolveAgentReadScope }
            : {}),
        ...(input.accessControlStore ? { accessControlStore: input.accessControlStore } : {}),
    });
    /**
     * Bring ONE record online. Mirrors the per-record gates of the restore pass
     * (`enabled` → mode → connectivity → credentials) so the reconciler's winner
     * and a cold-start restore can never disagree about what may start.
     */
    const startPlatformTransport = (platform, agentName) => startOnePlatformTransport({
        platform,
        agentName,
        quarantined: input.restoreInboundLoops === false,
        feishu: feishuArm,
        telegram: telegramArm,
        wechat: wechatArm,
    });
    /** Stop ONE agent's transport through the platform's existing teardown. */
    const teardownPlatformTransport = async (platform, agentName) => {
        // `register: false`: tearing a loser down must not create a registry entry
        // for the very transport edge we are removing.
        if (platform === 'feishu') {
            getOrCreateFeishuAdapter(agentName, { register: false }).invalidateTransport();
            return;
        }
        if (platform === 'telegram') {
            getOrCreateTelegramAdapter(agentName, { register: false }).shutdown();
            return;
        }
        getOrCreateWeChatAdapter(agentName, { register: false }).shutdown();
        return Promise.resolve();
    };
    // With `deferChannelStartup`, construction touches no transport at all and
    // `channelRestoreReady` settles with the FIRST restore the owner runs (the
    // single pass inside `startChannelSubsystem()`), not with a construction-time
    // pass. Standalone V1 keeps starting here.
    let settleRestoreReady;
    const restartInboundLoops = async () => {
        try {
            await runRestoreInboundLoops();
        }
        catch (err) {
            settleRestoreReady?.(err);
            settleRestoreReady = undefined;
            throw err;
        }
        settleRestoreReady?.();
        settleRestoreReady = undefined;
    };
    const channelRestoreReady = input.deferChannelStartup
        ? new Promise((resolve, reject) => {
            settleRestoreReady = (error) => (error === undefined ? resolve() : reject(error));
        })
        : restartInboundLoops();
    // The deferred owner observes a startup failure through its own
    // `startChannelSubsystem()` promise; keeping this one marked handled avoids
    // reporting the same failure a second time as an unhandled rejection.
    markHandled(channelRestoreReady);
    // C8: defence-in-depth binding gate. `dispatchInbound` consults this before
    // any processing and drops inbound whose `(agentName × platform)` binding is
    // gone. All three stores are the SAME instances the bind/unbind APIs mutate,
    // so a just-unbound agent's next inbound is discarded even if its transport
    // teardown lost a race.
    //
    // The gate only enforces for inbound that arrived under the canonical
    // managed clientName for its platform (what the real WS / poll / monitor /
    // webhook sources always set). Unrecognized client ids remain outside this
    // binding gate; outbound delivery still requires an exact registered client.
    input.runner.hasActiveChannelBinding = (ctx) => hasActiveManagedBinding(ctx, input.agentName, { feishuStore, telegramStore, wechatStore });
    return {
        feishu,
        feishuStore,
        feishuAdapter,
        feishuPendingQuestionnaires,
        feishuPendingPermissions,
        telegram,
        telegramStore,
        wechat,
        wechatStore,
        restartInboundLoops,
        startPlatformTransport,
        teardownPlatformTransport,
        channelRestoreReady,
    };
}
/**
 * The deferred owner observes a startup failure through its own
 * `startChannelSubsystem()` promise; marking this construction-time promise
 * handled avoids reporting the same failure twice as an unhandled rejection.
 */
export function markHandled(promise) {
    detach((async () => {
        try {
            await promise;
        }
        catch {
            // Intentionally swallowed — the owner path reports it.
        }
    })());
}
/**
 * C8 binding gate predicate (see the call-site comment): only canonical
 * managed clientNames are enforced; unknown ids stay outside the gate.
 */
async function hasActiveManagedBinding(ctx, defaultAgentName, stores) {
    const agentName = agentNameFromClientName(ctx.platform, ctx.clientName, defaultAgentName);
    if (ctx.platform === 'feishu') {
        if (ctx.clientName !== feishuClientId(agentName))
            return true;
        return Boolean((await stores.feishuStore.get(agentName))?.enabled);
    }
    if (ctx.platform === 'telegram') {
        if (ctx.clientName !== telegramClientId(agentName))
            return true;
        return Boolean((await stores.telegramStore.get(agentName))?.enabled);
    }
    if (ctx.platform === 'wechat') {
        if (ctx.clientName !== wechatClientId(agentName))
            return true;
        return hasUsableWeChatGateRecord(await stores.wechatStore.get(agentName));
    }
    return true;
}
/** WeChat gate needs the full credential shape, not just `enabled`. */
function hasUsableWeChatGateRecord(record) {
    return Boolean(record?.enabled &&
        record.connected &&
        record.mode === 'polling' &&
        record.botToken &&
        !record.botToken.startsWith('pending:'));
}
function channelStartFailed() {
    return new AgentContractHttpError(503, 'Channel transport could not be started', 'CHANNEL_START_FAILED');
}
/** Winner start for one platform record; see `startPlatformTransport` docs. */
async function startOnePlatformTransport(scope) {
    if (scope.platform === 'feishu')
        return startFeishuWinner(scope);
    if (scope.platform === 'telegram')
        return startTelegramWinner(scope);
    return startWeChatWinner(scope);
}
async function startFeishuWinner(scope) {
    const { agentName, quarantined } = scope;
    const { feishuStore, registerFeishuClient, getOrCreateFeishuAdapter, startFeishuWs } = scope.feishu;
    const record = await feishuStore.get(agentName);
    if (!record?.enabled) {
        logger.info({ agentName, platform: 'feishu' }, 'Channel winner start skipped: record disabled');
        return;
    }
    registerFeishuClient(record);
    getOrCreateFeishuAdapter(record.agentName);
    if (quarantined || record.mode !== 'websocket' || !record.connected) {
        logger.info({ agentName, platform: 'feishu', mode: record.mode }, 'Channel winner inbound not started');
        return;
    }
    try {
        if (!(await startFeishuWs(record.agentName)))
            throw channelStartFailed();
    }
    catch {
        throw channelStartFailed();
    }
}
async function startTelegramWinner(scope) {
    const { agentName, quarantined } = scope;
    const { telegramStore, telegram, getOrCreateTelegramAdapter } = scope.telegram;
    const record = await telegramStore.get(agentName);
    if (!record?.enabled) {
        logger.info({ agentName, platform: 'telegram' }, 'Channel winner start skipped: record disabled');
        return;
    }
    telegram.registerClient(record);
    if (quarantined ||
        record.mode !== 'sdk' ||
        !record.botToken ||
        record.botToken.startsWith('pending:')) {
        logger.info({ agentName, platform: 'telegram', mode: record.mode }, 'Channel winner inbound not started');
        return;
    }
    try {
        if (!(await getOrCreateTelegramAdapter(record.agentName).startPoller(record.botToken))) {
            throw channelStartFailed();
        }
    }
    catch {
        throw channelStartFailed();
    }
}
async function startWeChatWinner(scope) {
    const { agentName, quarantined } = scope;
    const { wechatStore, getOrCreateWeChatAdapter } = scope.wechat;
    const record = await wechatStore.get(agentName);
    if (!record?.enabled ||
        quarantined ||
        record.mode !== 'polling' ||
        !record.connected ||
        !record.botToken ||
        record.botToken.startsWith('pending:')) {
        logger.info({ agentName, platform: 'wechat', mode: record?.mode }, 'Channel winner inbound not started');
        return;
    }
    // Do not construct/register the adapter until every real credential gate
    // passed. In particular a pending QR must have no exact outbound edge.
    const adapter = getOrCreateWeChatAdapter(record.agentName);
    try {
        if (!(await adapter.startMonitor()))
            throw channelStartFailed();
    }
    catch {
        throw channelStartFailed();
    }
}
/**
 * Recover the bare agentName that the per-platform binding stores key on from
 * a runtime `ctx.clientName`. Telegram/WeChat clientNames carry a `telegram:` /
 * `wechat:` prefix (see `telegramClientId` / `wechatClientId`); Feishu uses the
 * bare agentName (`feishuClientId` is effectively identity). The stores re-apply
 * their own `xClientId` internally, so passing the bare agentName is required —
 * passing the prefixed clientName would double-prefix and miss the record.
 */
export function agentNameFromClientName(platform, clientName, fallbackAgentName) {
    let prefix = '';
    if (platform === 'telegram')
        prefix = 'telegram:';
    else if (platform === 'wechat')
        prefix = 'wechat:';
    const name = prefix && clientName.startsWith(prefix) ? clientName.slice(prefix.length) : clientName;
    return name.trim() || fallbackAgentName;
}
//# sourceMappingURL=channel-apis.js.map