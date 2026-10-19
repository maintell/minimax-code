/**
 * v2 channel-subsystem composition (single production owner).
 *
 * Migration copy (MR2): v1 `api/host-channels.ts` (`wireChannelSubsystem` +
 * `createChannelApis` + the legacy IM Connection migration) with every
 * dependency remapped onto v2 channel-system modules. One deliberate
 * structural change: the runner is constructed directly (v1's
 * `createChannelRunner` wrapper existed only for retired pre-conversation
 * options). Everything else — construction order, family reconciliation,
 * §5.6 lazy registration, restore/startup orchestration — is kept verbatim
 * so v1 behaviour carries over unchanged.
 */
import { LocalChannelBridgeInfra } from '../ingress/channel-bridge-infra.js';
import { LocalChannelRunner } from '../ingress/runner.js';
import { LocalChannelOwnerStore } from '../binding/storage/owner-store.js';
import { LocalAccessControlStore, bindAccessControlAuditLogger, } from '../access-control/access-control-store.js';
import { isUsableFeishuBinding } from '../transport/feishu/feishu-adapter-utils.js';
import { LocalChannelQuestionnaireBridge } from '../interaction/questionnaire-bridge.js';
import { LocalChannelPermissionBridge, } from '../interaction/permission-bridge.js';
import { createFeishuCardActionHandler } from '../interaction/feishu-card-action.js';
import { isUsableTelegramBinding, } from '../transport/telegram/telegram-store.js';
import { isUsableWeChatBinding, } from '../transport/wechat/wechat-store.js';
import { migrateLegacyImCredentialsOnStartup } from '../migration/legacy-im-migration-startup.js';
import { PrimaryAgentFamilyReconciler } from '../migration/primary-agent-family-reconciler.js';
import { PrimaryAgentRootReconciler, } from '../migration/primary-agent-root-reconciler.js';
import { repairPrimaryFamilySessionModels, } from '../migration/primary-agent-session-model-repair.js';
import { createChannelApis, agentNameFromClientName, markHandled, } from './channel-apis.js';
import { detach } from '../settle.js';
import { migrateLegacyImConnectionState, } from './legacy-connection-migration.js';
import { imLogger, imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
import { migrateRootlessChannelState } from '../migration/rootless-startup-migration.js';
/** Shorthand for the infra's manual-compaction seam (see `LocalChannelBridgeInfraOptions`). */
/** Ordered §5.3 pre-restore steps for one startup pass. */
async function runChannelStartupSteps(scope) {
    const { input, channelApis, channelBridgeInfra } = scope;
    if (input.runLegacyImCredentialMigration) {
        await input.runLegacyImCredentialMigration(() => migrateLegacyImCredentialsOnStartup({
            dataDir: input.dataDir,
            nowMs: input.nowMs,
            agentName: input.agentName,
            feishuStore: channelApis.feishuStore,
            telegramStore: channelApis.telegramStore,
            wechatStore: channelApis.wechatStore,
            bindingStore: channelBridgeInfra.bindingStore,
            getSessionById: input.getSessionById,
        }));
    }
    if (input.rootlessV2) {
        await migrateRootlessChannelState({
            dataDir: input.dataDir(),
            defaultAgentName: input.agentName,
            nowMs: input.nowMs,
            bindingStore: channelBridgeInfra.bindingStore,
            getSessionById: input.getSessionById,
            rootless: input.rootlessV2,
            ...(input.resolveAgentReadScope
                ? { resolveAgentReadScope: input.resolveAgentReadScope }
                : {}),
        });
        await migrateLegacyImConnectionState({
            dataDir: input.dataDir(),
            bindingStore: channelBridgeInfra.bindingStore,
            imConnectionStore: channelBridgeInfra.imConnectionStore,
            rootless: input.rootlessV2,
            getSessionById: input.getSessionById,
            isUsableWeChatRoute: async (route) => {
                const legacyAgentName = route.clientName.startsWith('wechat:')
                    ? route.clientName.slice('wechat:'.length).trim()
                    : '';
                return isUsableWeChatBinding(await channelApis.wechatStore.get(legacyAgentName || route.agentName));
            },
            // F4: the per-agent credential stores are the single source of
            // truth for which bot is active on a channel. Same-profile
            // client conflicts in the legacy rows are arbitrated against
            // this fact instead of skipping the whole group.
            resolveActiveClient: (query) => resolveActiveChannelClient(channelApis, query),
            ...(input.resolveAgentReadScope
                ? { resolveAgentReadScope: input.resolveAgentReadScope }
                : {}),
            ...(input.legacyImCredentialAgent
                ? { legacyImCredentialAgent: input.legacyImCredentialAgent }
                : {}),
        });
    }
    scope.installPrimaryFamilyHooks();
    await runPrimaryFamilyConvergence(scope);
    await channelApis.restartInboundLoops();
}
/**
 * Plan §5.5: startup reconcile converges persisted ownership only. Root /
 * model validation must complete before the sole restore starts live
 * inbound; concurrent family binds stay gated through those checks.
 */
async function runPrimaryFamilyConvergence(scope) {
    const { input, primaryFamilyReconciler, primaryRootReconciler } = scope;
    if (!primaryFamilyReconciler)
        return;
    scope.setSuppressPrimaryFamilyTransportStart(true);
    try {
        await primaryFamilyReconciler.reconcileAll();
        if (input.conversation && !input.rootlessV2) {
            if (!primaryRootReconciler || !input.primaryFamilySessionModels || !input.configGetter) {
                throw new Error('PRIMARY_AGENT_STARTUP_PORT_UNWIRED');
            }
            const { scopedSessionIds } = await primaryRootReconciler.reconcile();
            await repairPrimaryFamilySessionModels({ config: input.configGetter, sessions: input.primaryFamilySessionModels }, scopedSessionIds);
        }
    }
    finally {
        scope.setSuppressPrimaryFamilyTransportStart(false);
    }
}
/** F4 arbiter: which clientId currently owns this agent's channel profile. */
async function resolveActiveChannelClient(channelApis, query) {
    if (query.channel === 'telegram') {
        const record = await channelApis.telegramStore.get(query.agentName);
        return isUsableTelegramBinding(record) ? record.clientId : undefined;
    }
    if (query.channel === 'wechat') {
        const record = await channelApis.wechatStore.get(query.agentName);
        return isUsableWeChatBinding(record) ? record.clientId : undefined;
    }
    const record = await channelApis.feishuStore.get(query.agentName);
    return isUsableFeishuBinding(record) ? record.clientId : undefined;
}
/**
 * Idempotent startup entrypoint + readiness promise. Concurrent and repeat
 * calls share the first execution; a disabled capability policy settles
 * readiness without reading, migrating or restoring any Channel state.
 */
function buildChannelStartup(scope) {
    let startup;
    let settleReady;
    const channelRestoreReady = new Promise((resolve, reject) => {
        settleReady = (error) => (error === undefined ? resolve() : reject(error));
    });
    markHandled(channelRestoreReady);
    const startChannelSubsystem = () => {
        startup ??= (async () => {
            try {
                if (scope.input.channelCapabilityPolicy === 'disabled') {
                    logger.info({ agentName: scope.input.agentName, stage: 'channel_startup' }, 'Channel subsystem startup skipped: capability disabled');
                    settleReady();
                    return;
                }
                await runChannelStartupSteps(scope);
                settleReady();
            }
            catch (err) {
                settleReady(err);
                throw err;
            }
        })();
        return startup;
    };
    return { startChannelSubsystem, channelRestoreReady };
}
/** Resolve the per-channel owner store, honouring an optional test override. */
function resolveChannelOwnerStore(dataDir, nowMs, override) {
    return override ?? new LocalChannelOwnerStore(dataDir, nowMs);
}
/**
 * Resolve the per-channel Access Control store, honouring an optional
 * test override. Sits next to {@link resolveChannelOwnerStore} so the
 * wire layer + tests can stub either store independently. Returns
 * `undefined` when neither `override` nor a default is desired (e.g.
 * the AC feature is opt-out for legacy hosts that still depend on the
 * owner-gate-only behaviour).
 */
function resolveChannelAccessControlStore(dataDir, nowMs, override, auditLogger) {
    return (override ??
        new LocalAccessControlStore(dataDir, nowMs, auditLogger ? { logger: auditLogger } : {}));
}
const ACCESS_CONTROL_GUIDE_URL = 'https://vrfi1sk8a0.feishu.cn/docx/Hpx4dmOawomEI9xWqFkcm1kynae';
const ACCESS_CONTROL_DENY_REPLY_ZH = [
    '无权限，无法与该 Agent 对话。请联系 owner 开通权限。',
    `配置指南：${ACCESS_CONTROL_GUIDE_URL}`,
].join('\n');
const ACCESS_CONTROL_DENY_REPLY_EN = [
    "You don't have permission to chat with this Agent. Please contact the owner to grant access.",
    `Configuration guide: ${ACCESS_CONTROL_GUIDE_URL}`,
].join('\n');
function resolveAccessControlDenyLocale() {
    const locale = (process.env.NEXT_PUBLIC_LOCALE ?? process.env.MAVIS_ELECTRON_LOCALE)
        ?.trim()
        .toLowerCase();
    return /^en(?:[-_]|$)/u.test(locale ?? '') ? 'en' : 'zh';
}
/**
 * Migration doc §接入点 7: build a short, non-leaky deny notice for
 * the sender. Never surfaces allowlist contents, the recorded owner,
 * or internal reason codes — the caller (the bridge) appends the
 * `access-control:<reason>` code to its `accessDeniedReason` for ops
 * dashboards, but the user-facing reply uses generic copy so an
 * attacker cannot probe the policy by sending crafted messages.
 */
function formatAccessControlDenyReply(reason, isP2p) {
    const base = resolveAccessControlDenyLocale() === 'en'
        ? ACCESS_CONTROL_DENY_REPLY_EN
        : ACCESS_CONTROL_DENY_REPLY_ZH;
    // Reason is logged for ops but never inlined into the user-facing
    // text — keeping the surface generic means the operator can rename
    // a reason later without migrating user-visible copy.
    void reason;
    void isP2p;
    return base;
}
/**
 * Construct the per-platform `LocalChannelBridgeInfra` wired to the host's
 * session/queue/agent-routes and the resolved owner store. The default
 * owner-gate policy is `p => p !== 'wechat'` — see plan D2; Phase 5 may
 * introduce a group allowlist.
 */
function createChannelBridgeInfra(input) {
    if (input.override)
        return input.override;
    return new LocalChannelBridgeInfra({
        dataDir: input.dataDir,
        defaultAgentName: input.defaultAgentName,
        nowMs: input.nowMs,
        resolveDefaultWorkspaceDir: input.resolveDefaultWorkspaceDir,
        getSessionById: input.getSessionById,
        listSessions: input.listSessions,
        createSession: input.createSession,
        enqueueMessage: input.enqueueMessage,
        abortSession: input.abortSession,
        ownerStore: input.ownerStore,
        requiresOwnerGate: input.requiresOwnerGate ?? ((p) => p !== 'wechat'),
        ...optionalSessionInfraOptions(input),
        ...optionalRuntimeInfraOptions(input),
    });
}
/** Optional session/agent-facing wiring, spread only when supplied. */
function optionalSessionInfraOptions(input) {
    return {
        ...(input.resolveAgentReadScope ? { resolveAgentReadScope: input.resolveAgentReadScope } : {}),
        ...(input.resolveAgentWriteTarget
            ? { resolveAgentWriteTarget: input.resolveAgentWriteTarget }
            : {}),
        ...(input.revealMigratedSession ? { revealMigratedSession: input.revealMigratedSession } : {}),
        ...(input.createRootSession ? { createRootSession: input.createRootSession } : {}),
        ...(input.rootlessV2 ? { rootlessV2: input.rootlessV2 } : {}),
        ...(input.imConversationModel ? { imConversationModel: true } : {}),
    };
}
/** Optional runtime/observability wiring, spread only when supplied. */
function optionalRuntimeInfraOptions(input) {
    return {
        ...(input.emitBusEvent ? { emitBusEvent: input.emitBusEvent } : {}),
        ...(input.metrics ? { metrics: input.metrics } : {}),
        ...(input.requestCompaction ? { requestCompaction: input.requestCompaction } : {}),
        ...(input.accessControlStore ? { accessControlStore: input.accessControlStore } : {}),
    };
}
/** Root reconciler exists only for rooted hosts with the family + session ports. */
function buildPrimaryRootReconciler(input, primaryFamilyReconciler) {
    return !input.rootlessV2 &&
        primaryFamilyReconciler &&
        input.resolveAgentReadScope &&
        input.primaryFamilyRootSessions
        ? new PrimaryAgentRootReconciler({
            resolveAgentReadScope: input.resolveAgentReadScope,
            sessions: input.primaryFamilyRootSessions,
        })
        : undefined;
}
/**
 * MR-D2: platform-agnostic permission bridge. Shares the same binding store +
 * adapter registry as the questionnaire bridge so a single bound IM
 * conversation can carry both ask_user cards and permission cards. The host
 * wires it into `LocalPermissionRouteContext.channelPermissionOutbound` so
 * the approval service fans the ask out fire-and-forget (the bridge owns its
 * own try/catch). The V2 IM Connection store (present only when rootlessV2 +
 * imConversationModel are on) is handed over as the route port because
 * sessions created by a V2 Binding have no legacy binding row to prove the
 * origin chat is bound.
 */
function buildChannelPermissionBridge(input, channelBridgeInfra) {
    const imRoutes = channelBridgeInfra.imConnectionStore;
    return new LocalChannelPermissionBridge({
        bindingStore: channelBridgeInfra.bindingStore,
        adapterRegistry: channelBridgeInfra.adapterRegistry,
        nowMs: input.nowMs,
        ...(imRoutes ? { imRoutes } : {}),
        ...(input.resolveChannelTurnOrigin ? { resolveOrigin: input.resolveChannelTurnOrigin } : {}),
        ...(input.metricsReporter ? { metrics: input.metricsReporter } : {}),
    });
}
/**
 * Card-action seam construction. Same host seam MR-1 wired for the runner's
 * Telegram inbound path: Feishu card clicks arrive on the card-action HTTP
 * endpoint (not dispatchInbound), so the permission branch settles them
 * through the applier directly.
 */
function buildFeishuCardActionSeam(scope) {
    const { input, channelBridgeInfra, feishuPlatformAdapter, submitQuestionnaireReply } = scope;
    const applyPermissionReply = input.applyPermissionReply;
    return createFeishuCardActionHandler({
        agentName: input.agentName,
        feishuPlatformAdapter,
        feishuPendingQuestionnaires: scope.feishuPendingQuestionnaires,
        feishuPendingPermissions: scope.feishuPendingPermissions,
        questionnaireBridge: scope.questionnaireBridge,
        ...(submitQuestionnaireReply ? { submitQuestionnaireReply } : {}),
        ...(applyPermissionReply ? { applyPermissionReply } : {}),
        getAdapter: (clientName) => channelBridgeInfra.adapterRegistry.get('feishu', clientName ?? feishuPlatformAdapter.clientName),
        ...(input.metricsReporter ? { metrics: input.metricsReporter } : {}),
    });
}
/** Assemble the CreateChannelApisInput; optional test seams spread only when set. */
function buildChannelApisInput(scope) {
    const { input, channelRunner } = scope;
    return {
        dataDir: input.dataDir,
        nowMs: input.nowMs,
        runner: channelRunner,
        agentName: input.agentName,
        ownerStore: scope.channelOwnerStore,
        accessControlStore: scope.channelAccessControlStore,
        makeId: input.makeId,
        adapterRegistry: scope.channelBridgeInfra.adapterRegistry,
        preflightInbound: (preflightInput) => channelRunner.preflightInbound(preflightInput),
        fetchImpl: input.fetchImpl,
        cardActionHandlerProvider: scope.cardActionHandlerProvider,
        stores: {
            feishu: input.feishuChannelStoreOverride,
            telegram: input.telegramChannelStoreOverride,
            wechat: input.wechatChannelStoreOverride,
        },
        ...(input.telegramTokenVerifyFetcher
            ? { telegramTokenVerifyFetcher: input.telegramTokenVerifyFetcher }
            : {}),
        ...(input.wechatOnboardFetcher ? { wechatOnboardFetcher: input.wechatOnboardFetcher } : {}),
        ...(input.feishuWsEnabled === false ? { feishuWsEnabled: false } : {}),
        restoreInboundLoops: input.restoreInboundLoops,
        // The wire's startup orchestration owns the single restore pass for every
        // caller of `wireChannelSubsystem`, deferred or not.
        deferChannelStartup: true,
        ...(input.resolveAgentReadScope ? { resolveAgentReadScope: input.resolveAgentReadScope } : {}),
        ...(input.wechatRuntimeSdkOverride ? { wechatRuntimeSdk: input.wechatRuntimeSdkOverride } : {}),
    };
}
/**
 * Plan §5: converge the primary Agent family onto ONE enabled channel owner
 * per platform. Only wired when the host injected an Agent resolver — the
 * family must come from the resolver, never from a hardcoded name list here.
 */
function buildPrimaryFamilyReconciler(scope) {
    const { input, channelApis, channelBridgeInfra, channelRunner } = scope;
    if (!input.resolveAgentReadScope)
        return undefined;
    return new PrimaryAgentFamilyReconciler({
        resolveAgentReadScope: input.resolveAgentReadScope,
        stores: {
            feishu: channelApis.feishuStore,
            telegram: channelApis.telegramStore,
            wechat: channelApis.wechatStore,
        },
        bindingStore: channelBridgeInfra.bindingStore,
        ownerStore: scope.channelOwnerStore,
        accessControlStore: scope.channelAccessControlStore,
        dataDir: input.dataDir,
        nowMs: input.nowMs,
        defaultAgentName: input.agentName,
        teardownTransport: (platform, agentName) => channelApis.teardownPlatformTransport(platform, agentName),
        unregisterTransport: (platform, clientId) => {
            channelRunner.clients.unregister(clientId);
            channelBridgeInfra.adapterRegistry.unregister(platform, clientId);
        },
        startTransport: (platform, agentName) => scope.isTransportStartSuppressed()
            ? undefined
            : channelApis.startPlatformTransport(platform, agentName),
    });
}
/**
 * Migration doc §接入点 7: deliver a one-line "no permission" notice back to
 * the sender when Access Control denies an inbound. P2p always; group only
 * when the inbound explicitly @-mentioned the bot (avoids bot spam in
 * unrelated group traffic). Delivery always uses the exact platform SDK edge
 * registered for this binding.
 */
function buildAccessControlDenyReply(channelRunner) {
    return async ({ ctx, reason }) => {
        const isP2p = !ctx.chatType || /^(p2p|private|dm)$/iu.test(ctx.chatType);
        if (!isP2p && ctx.hasMention !== true)
            return 'suppressed';
        let client;
        try {
            client = channelRunner.clients.get(ctx);
        }
        catch {
            return 'unavailable';
        }
        const text = formatAccessControlDenyReply(reason, isP2p);
        await client.sendText({ ctx, text });
        return 'sent';
    };
}
/** Non-accepted questionnaire outcomes get one metadata-only warn line. */
function wrapSubmitQuestionnaireReply(rawSubmitQuestionnaireReply) {
    if (!rawSubmitQuestionnaireReply)
        return undefined;
    return async (replyInput) => {
        const outcome = await rawSubmitQuestionnaireReply(replyInput);
        if (outcome && outcome.status !== 'accepted') {
            // Log routing and settlement metadata only; never include the user's
            // reply or answers.
            logger.warn({
                requestId: replyInput.requestId,
                agentName: replyInput.agentName,
                status: outcome.status,
                ...(outcome.code ? { code: outcome.code } : {}),
            }, 'Questionnaire reply returned non-accepted outcome');
        }
        return outcome;
    };
}
/** Infra construction with the wire's owner/AC stores threaded in. */
function buildWireBridgeInfra(input, channelOwnerStore, channelAccessControlStore) {
    return createChannelBridgeInfra({
        dataDir: input.dataDir,
        defaultAgentName: input.agentName,
        ...(input.resolveAgentReadScope ? { resolveAgentReadScope: input.resolveAgentReadScope } : {}),
        ...(input.resolveAgentWriteTarget
            ? { resolveAgentWriteTarget: input.resolveAgentWriteTarget }
            : {}),
        nowMs: input.nowMs,
        resolveDefaultWorkspaceDir: input.resolveDefaultWorkspaceDir,
        getSessionById: input.getSessionById,
        listSessions: input.listSessions,
        createSession: input.createSession,
        ...(input.revealMigratedSession ? { revealMigratedSession: input.revealMigratedSession } : {}),
        createRootSession: input.createRootSession,
        ...(input.rootlessV2 ? { rootlessV2: input.rootlessV2 } : {}),
        ...(input.imConversationModel ? { imConversationModel: true } : {}),
        enqueueMessage: input.enqueueMessage,
        abortSession: input.abortSession,
        emitBusEvent: input.emitBusEvent,
        ...(input.metricsReporter ? { metrics: input.metricsReporter } : {}),
        ...(input.requestCompaction ? { requestCompaction: input.requestCompaction } : {}),
        ownerStore: channelOwnerStore,
        requiresOwnerGate: input.requiresOwnerGate ?? ((p) => p !== 'wechat'),
        accessControlStore: channelAccessControlStore,
        ...(input.bridgeInfraOverride ? { override: input.bridgeInfraOverride } : {}),
    });
}
/**
 * v2 runner construction. Conversation-first: the retired v1 legacy-dispatch
 * options (getSessionById / queueStore / runQueuedTurn / kickChannelDrain) do
 * not exist any more, so the runner is constructed directly; `runnerOverride`
 * stays supported for composition tests. Inbound permission interception and
 * the questionnaire reply hop mirror the v1 wiring verbatim.
 */
function buildChannelRunner(scope) {
    const { input, channelBridgeInfra, channelPermissionBridge } = scope;
    const applyPermissionReply = input.applyPermissionReply;
    if (input.runnerOverride)
        return input.runnerOverride;
    return new LocalChannelRunner({
        infra: channelBridgeInfra,
        dataDir: input.dataDir,
        nowMs: input.nowMs,
        makeId: input.makeId,
        conversation: input.conversation,
        // Inbound permission interception (Phase 1): resolve the raw platform
        // callback against the bridge's pending map, then settle the pending
        // request through the host's `applyPermissionReply` seam. Only wired
        // when the host provides the applier — otherwise the runner never
        // consults the bridge and callbacks keep the pre-MR fallthrough.
        ...(applyPermissionReply
            ? {
                tryPermissionReply: (ctx, raw) => channelPermissionBridge.tryPermissionReply(ctx, raw),
                permissionReplyHandler: async ({ requestId, behavior, }) => {
                    await applyPermissionReply({ requestId, behavior });
                },
            }
            : {}),
        questionnaireReplyHandler: async ({ ctx, reply }) => {
            // Mirror the Feishu card-action handler: bridge.submit lets the bridge
            // run its own bookkeeping (`submittedAt` defaulting), then we drive the
            // host's reply route so the suspended agent turn actually resumes.
            // Without the second hop the user's answer is accepted server-side but
            // the bot stays silent.
            await scope.questionnaireBridge.submit({ ctx, reply });
            if (scope.submitQuestionnaireReply) {
                const resolved = await scope.submitQuestionnaireReply({
                    agentName: agentNameFromClientName(ctx.platform, ctx.clientName, input.agentName),
                    requestId: reply.requestId,
                    reply,
                });
                return resolved ?? { status: 'accepted' };
            }
            return { status: 'accepted' };
        },
        ...(input.metricsReporter ? { metrics: input.metricsReporter } : {}),
    });
}
export function wireChannelSubsystem(input) {
    const channelOwnerStore = resolveChannelOwnerStore(input.dataDir, input.nowMs, input.ownerStoreOverride);
    const channelAccessControlStore = resolveChannelAccessControlStore(input.dataDir, input.nowMs, input.accessControlStoreOverride, bindAccessControlAuditLogger(imLogger));
    const channelBridgeInfra = buildWireBridgeInfra(input, channelOwnerStore, channelAccessControlStore);
    // Construct the questionnaire bridge first so the channel runner can be
    // wired with `tryHandleQuestionnaireReply` interception on dispatchInbound.
    // Bridge `onSubmit` stays no-op: the Feishu card-action handler manually
    // drives `submitQuestionnaireReply` after `bridge.submit` (see below) and
    // we mirror that pattern at the runner level so the existing flow does
    // not break.
    const submitQuestionnaireReply = wrapSubmitQuestionnaireReply(input.submitQuestionnaireReply);
    const questionnaireBridge = new LocalChannelQuestionnaireBridge();
    // MR-D2: platform-agnostic permission bridge. Shares the same binding
    // store + adapter registry as the questionnaire bridge so a single bound
    // IM conversation can carry both ask_user cards and permission cards.
    // The host wires it into `LocalPermissionRouteContext.channelPermissionOutbound`
    // so the approval service fans the ask out to
    // bound conversations fire-and-forget (the bridge owns its own try/catch).
    // Constructed BEFORE the runner so `dispatchInbound` can consult
    // `tryPermissionReply` on every inbound (inbound wiring, Phase 1).
    const channelPermissionBridge = buildChannelPermissionBridge(input, channelBridgeInfra);
    const channelRunner = buildChannelRunner({
        input,
        channelBridgeInfra,
        channelPermissionBridge,
        questionnaireBridge,
        submitQuestionnaireReply,
    });
    // Migration doc §接入点 7: deliver a one-line "no permission" notice
    // back to the sender when Access Control denies an inbound. P2p
    // always; group only when the inbound explicitly @-mentioned the
    // bot (avoids bot spam in unrelated group traffic). Delivery always uses
    // the exact platform SDK edge registered for this binding.
    channelBridgeInfra.accessControlDenyReply = buildAccessControlDenyReply(channelRunner);
    const channelApis = createChannelApis(buildChannelApisInput({
        input,
        channelRunner,
        channelOwnerStore,
        channelAccessControlStore,
        channelBridgeInfra,
        // Lazy provider so the WS dispatcher can route Feishu `card.action.trigger`
        // events through the same handler that the public webhook uses. v2
        // adaptation: the handler lives in this composition (the v2 infra copy
        // deliberately dropped the `feishuCardActionHandler` HTTP seam), assigned
        // a few lines below. WS only starts after a bind, so by the time it fires
        // the handler is wired.
        cardActionHandlerProvider: () => feishuCardActionHandler,
    }));
    // MR-C: register the unified FeishuPlatformAdapter against the shared
    // LocalFeishuChannelStore so the legacy LocalFeishuChannelApi and the new
    // adapter agree on a single set of persisted bindings. The questionnaire
    // bridge stays stateless and is shared across all adapters; the
    // `feishuCardActionHandler` decodes Feishu card callbacks into a structured
    // reply payload before handing them to the bridge's submit hook (which the
    // host wires later when the questionnaire store is plumbed in).
    const feishuPlatformAdapter = channelApis.feishuAdapter;
    const feishuPendingQuestionnaires = channelApis.feishuPendingQuestionnaires;
    const feishuPendingPermissions = channelApis.feishuPendingPermissions;
    // Host-supplied submit callback drives reply delivery (→ the questionnaire
    // reply route → resume the suspended agent turn). Without this the form
    // "looks frozen" after the user taps Submit because the bridge submit
    // hook defaults to a no-op.
    // (questionnaireBridge / submitQuestionnaireReply are constructed above
    // so the channel runner can use them for tryHandleQuestionnaireReply.)
    // v2 adaptation: the card-action handler is a composition-owned seam (the
    // v2 infra copy has no `feishuCardActionHandler` field). It is exposed on
    // the wire result so the legacy `channel-bridge/feishu/card-action` HTTP
    // facade and the WS dispatcher hit the SAME instance (proposal §6.4).
    const feishuCardActionHandler = buildFeishuCardActionSeam({
        input,
        channelBridgeInfra,
        feishuPlatformAdapter,
        feishuPendingQuestionnaires,
        feishuPendingPermissions,
        questionnaireBridge,
        submitQuestionnaireReply,
    });
    // Expose the bridge + adapter via private fields on the infra so tests can
    // reach into them without an extra wiring seam; production callers should
    // go through `channelBridgeInfra.adapterRegistry.get(...)`.
    // (channelPermissionBridge is constructed above, before the runner, so the
    // runner's inbound permission interception can reference it.)
    // One-time forward-compat: migrate legacy per-agent IM credentials
    // (`<dataDir>/credentials/<agent>/{feishu,telegram,wechat}.json`) into the
    // current channel stores + routes. The import writes state only — the single
    // restore pass that `startChannelSubsystem()` runs afterwards is what brings
    // the migrated Telegram/WeChat records online in THIS boot.
    // Plan §5: converge the primary Agent family onto ONE enabled channel owner
    // per platform. Only wired when the host injected an Agent resolver — the
    // family must come from the resolver, never from a hardcoded name list here.
    let suppressPrimaryFamilyTransportStart = false;
    const primaryFamilyReconciler = buildPrimaryFamilyReconciler({
        input,
        channelApis,
        channelBridgeInfra,
        channelRunner,
        channelOwnerStore,
        channelAccessControlStore,
        isTransportStartSuppressed: () => suppressPrimaryFamilyTransportStart,
    });
    const installPrimaryFamilyHooks = () => {
        if (!primaryFamilyReconciler)
            return;
        channelApis.feishuStore.setFamilyMutationHook(primaryFamilyReconciler.mutationHook('feishu'));
        channelApis.telegramStore.setFamilyMutationHook(primaryFamilyReconciler.mutationHook('telegram'));
        channelApis.wechatStore.setFamilyMutationHook(primaryFamilyReconciler.mutationHook('wechat'));
    };
    const primaryRootReconciler = buildPrimaryRootReconciler(input, primaryFamilyReconciler);
    const { startChannelSubsystem, channelRestoreReady } = buildChannelStartup({
        input,
        channelApis,
        channelBridgeInfra,
        installPrimaryFamilyHooks,
        primaryFamilyReconciler,
        primaryRootReconciler,
        setSuppressPrimaryFamilyTransportStart: (value) => {
            suppressPrimaryFamilyTransportStart = value;
        },
    });
    if (input.deferChannelStartup !== true) {
        detach((async () => {
            try {
                await startChannelSubsystem();
            }
            catch (err) {
                logger.error({ err }, 'Channel subsystem startup failed');
            }
        })());
    }
    return {
        channelOwnerStore,
        channelAccessControlStore,
        channelBridgeInfra,
        channelRunner,
        channelPermissionBridge,
        feishuChannelApi: channelApis.feishu,
        telegramChannelApi: channelApis.telegram,
        wechatChannelApi: channelApis.wechat,
        feishuCardActionHandler,
        startChannelSubsystem,
        channelRestoreReady,
    };
}
//# sourceMappingURL=wire.js.map