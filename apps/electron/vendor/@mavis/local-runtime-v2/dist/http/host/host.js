import { buildHostMavisSessionAdapter } from './session/host-session-adapter.js';
import { HostResourceLifecycle } from './host-lifecycle.js';
import { ProcessLocalPermissionModeWriter } from './host-permission-mode.js';
import { join } from 'node:path';
import { initializeHostEnvironment, resolveHostIdentityOptions, resolveHostConfigOptions, readTuiWindowsHardSafetyOptOut, resolveHostCapabilityOptions, resolveHostModelResolver, resolveHostShellFamily, } from './host-environment.js';
import { HostChannelRuntime } from './host-channel-runtime.js';
import { createHostSessionPersistence, createHostSessionHistory, initializeHostSessionProjections, } from './session/host-session-persistence.js';
import { LocalPermissionRuleStore, LocalPermissionApprovalService, resolveLocalPermissionService, abortLocalPermissionRequests, readLocalPermissionMode, } from '../../service/permission/index.js';
import { createLocalFileApiGitChangesCoordinator } from '../../service/workspace/index.js';
import { LocalGreetingSystemReminderSender } from './host-greeting-sender.js';
import { wakeSessionQueueAfterDependencyRelease as wakeHostSessionQueue } from './turn/host-background-tasks.js';
import { routeHostApi } from './host-api-router.js';
import { createHostCronRuntime, startHostCronRuntime } from './host-cron-runtime.js';
import { buildDesktopServiceHandler as buildDesktopHandler } from './desktop-service-handler.js';
import { createSessionSendWaitGraph, LocalSessionController, LocalMessageQueueStore, } from '../../service/session-system/index.js';
import { createLocalMavisAgentAdapter, } from '../../service/agent/index.js';
import { copyPendingQuestionnaireForFork as copyPendingQuestionnaire, reopenQuestionnaireAfterSafetyRecall as reopenQuestionnaire, } from '../../service/questionnaire/index.js';
import { startQuestionnaireRecovery } from '../../service/questionnaire/index.js';
import { hasActiveLocalTeamOwner, runForegroundLocalTask } from '../../service/team/index.js';
import { isLocalRuntimeStartupExecutionEnabled } from '../../infra/runtime-owner/startup-execution-policy.js';
import { LocalHookService } from '../../service/hook/index.js';
import { LocalBrowserBroker } from '../../service/browser-use/index.js';
import { LocalPiHistoryStore } from '../../service/session-system/index.js';
import { LocalTurnFileChangeCaptureService } from '../../service/turn-system/index.js';
import {} from '../../infra/conversation/session-record.js';
import { createLocalGreetingSystemReminderSender, createHostHookService, } from './turn/host-turn-service-factories.js';
import { resolveLocalRuntimeLocale } from '../../infra/config/locale.js';
import { LegacyOpencodeRuntime } from '../../infra/legacy-db/legacy-opencode-runtime.js';
import { buildLocalRuntimeSurfaceCapabilities, buildLocalRuntimeCapabilities, legacyRuntimeEnabledForMode, } from '../../infra/runtime-owner/mode.js';
import { buildPermissionRouteContext, buildQuestionnaireServiceDeps, createHostRouteContext, createQuestionnaireOwnedActionBinder, createQuestionnaireRequestAdmissionBinder, } from './host-route-contexts.js';
import { hostNormalizeCleanLocalSession, hostSerializeSession, hostSerializeSessions, hostSerializeSessionTree, } from './session/host-session-state.js';
import { requestConversationCompaction } from './routes/compaction.js';
import { deliverQuestionnaireAskToChannel as deliverQuestionnaireAskToChannelHelper } from './interaction/host-questionnaire-delivery.js';
import { resolveHostStores } from './host-stores.js';
import { makeId } from '../../infra/transport/host-http.js';
import { isReadOnlyLegacySession, markMigratedLegacySessionDeleted, } from './session/host-legacy-helpers.js';
import { LocalApiAgentRoutes } from './routes/agents.js';
import { buildRuntimeDoctorSnapshot, resolveDefaultLocalWorkspaceDir } from './host-support.js';
import { resolveLocalApiHostEntryPath, resolveStrictMavisApiPath, routeLocalRuntimeRequest, } from './host-routing.js';
import { buildLocalTurnToolSourcesForHost, } from '../../service/turn-system/index.js';
import { createHostedCapabilities, isCliRestrictedRuntime, } from '../../service/session-handoff/index.js';
import { createLocalMemorySubsystem, handleMemoryBusEvent, } from '../../service/memory-system/index.js';
import { settleInBackground } from '../../service/plugin-system/index.js';
import { createGlobalEventSource, } from '../../infra/events/global-events.js';
import { createWorkspaceIndexingHostSubsystem, hostCaptureWorkspaceRevisionAfterTurn, hostLogWorkspaceSemanticSearchUnavailable, hostPrewarmWorkspaceIndexingForWorkspace, hostPrepareWorkspaceIndexingForSessionStart, } from '../../service/workspace/index.js';
export class LocalRuntimeApiHost {
    controller;
    runtimeConversation;
    /** Trusted Desktop / embedded CLI / TUI / app-server gate for direct Task admission. */
    useImmediateTaskAdmission;
    reviewPromptDir;
    /**
     * Decision v3 ask_user suppression probe, late-bound by the V2 runtime once
     * its Turn system exists (V1-only hosts leave it unset — never suppress).
     * Read through `buildQuestionnaireServiceDeps` at each tool assembly.
     */
    hasPendingUserSteeringProbe;
    /** IM follow-up active-Turn probe, late-bound by the V2 runtime (unset: IM follow-ups queue). */
    activeTurnChannelProbe;
    /** Read-only "was this IM event merged" lookup, bound with the probe (unset: check skipped). */
    findMergedChannelEvent;
    isQuestionnaireGoalActive;
    isQuestionnaireOriginTurnRunning;
    /** AskUser v2 sync-wait probe: user input queued at/after `sinceMs` (late-bound by V2). */
    hasQueuedUserInputSinceProbe;
    /** Read-only projection from the V2 Pin owner for legacy Session responses. */
    readSessionPinned;
    legacyRuntime;
    legacyOpencodeEnabled;
    runtimeMode;
    capabilityProfile;
    capabilities;
    surfaces;
    telemetry;
    matrixLogger;
    metricsClient;
    configGetter;
    shellFamily;
    /** TUI-only opt-out, frozen at startup rather than read from tool/session input. */
    skipWindowsHardSafetyChecks;
    authContextGetter;
    authContextInvalidator;
    routingContextGetter;
    isContextWindowUsageEnabled;
    fetchImpl;
    /**
     * Host-wide graph of in-flight blocking waits between Sessions, used to stop
     * a synchronous `session send` from closing a deadlock ring.
     *
     * It has to live here and nowhere lower: `buildOwnerTurnToolSources()` builds
     * a fresh Mavis Session adapter for every Turn, so a graph owned by the
     * adapter would start empty on the far side of every ring and never see the
     * edge it is supposed to detect. One graph per host instance also keeps two
     * hosts in one process from reading each other's waits as cycles.
     */
    sessionSendWaitGraph = createSessionSendWaitGraph();
    /** V2-owned desktop composer send preference; absent means the `queue` default. */
    composerSendBehavior;
    llmRequestFailureHook;
    recordSessionBashCompletion;
    observeLLMRequest;
    errorReporter;
    configUpdater;
    modelResolver;
    greetingSystemReminderSender;
    agentName;
    agentDisplayName;
    defaultWorkspaceDir;
    nowMs;
    messageStore;
    piHistoryStore;
    workspaceIndexingStore;
    workspaceIndexingService;
    workspaceIndexingRemoteClient;
    workspaceIndexingRemoteWorker;
    workspaceSemanticIndexStore;
    workspaceSemanticSearchService;
    /** Owner-injected factory for the Workspace indexing lifecycle sink; absent = unobserved. */
    createWorkspaceIndexingObservationSink;
    communicationMessageStore;
    tokenUsageStore;
    turnDiffStore;
    turnFileChanges;
    backgroundTaskRuntime;
    get backgroundTasks() {
        if (!this.backgroundTaskRuntime) {
            throw new Error('Background tasks require the V2 runtime owner');
        }
        return this.backgroundTaskRuntime;
    }
    get backgroundTaskService() {
        return this.backgroundTasks.service;
    }
    cronStore;
    /** Late-bound local-runtime-v2 Goal owner; see `bindQuestionnaireWorkOwner`. */
    boundQuestionnaireWorkOwner;
    /** Late-bound local-runtime-v2 Goal owner; see `bindSubSessionRoundAttribution`. */
    boundSubSessionRoundAttribution;
    cronRuntime;
    contentSafety;
    contentSafetyChecker;
    agentRuntimePort;
    officialModelConfigRefresh = () => Promise.resolve();
    bindOfficialModelConfigRefresh(refresh) {
        this.officialModelConfigRefresh = refresh;
    }
    refreshOfficialModels() {
        return this.officialModelConfigRefresh();
    }
    /** Neutral reference port supplied by the owning runtime (V2 in production). */
    agentResolver;
    // desktop-service-boundary-skip: anchor=host-desktop-handler-field owner=local-runtime reason=host retains generated handler before DesktopService facade migration; followup=desktop-service-domain-facades
    desktopServiceHandler;
    memoryFacade;
    skillRuntime;
    pluginHookPermissionStore;
    localDataCollector;
    systemReminderService;
    questionnaireStore;
    mcpRuntime;
    get mcpService() {
        if (!this.mcpRuntime)
            throw new Error('MCP runtime is not available on this host');
        return this.mcpRuntime;
    }
    hookService;
    metrics;
    browserBroker;
    channelRuntime;
    hostDiagnosticsProvider;
    permissionRules;
    permissionApprovalService;
    legacyMigrator;
    agentRoutes;
    lockOwner;
    runtimeStartupToken;
    promptSnapshots;
    internalTurnPromptReads;
    startupExecutionEnabled;
    channelCapabilityEnabled;
    globalEvents = createGlobalEventSource();
    globalEventPublisher;
    lifecycle = new HostResourceLifecycle(() => ({
        backgroundTaskRuntime: this.backgroundTaskRuntime,
        workspaceIndexingService: this.workspaceIndexingService,
        workspaceIndexingRemoteWorker: this.workspaceIndexingRemoteWorker,
        globalEvents: this.globalEvents,
        errorReporter: this.errorReporter,
    }));
    mavisCronAdapterProvider;
    deleteAgentCronTasksOverride;
    fileGitChangesCoordinator = createLocalFileApiGitChangesCoordinator();
    cronQueueStore;
    constructor(options = {}) {
        const identity = resolveHostIdentityOptions(options);
        const config = resolveHostConfigOptions(options);
        const capabilityOptions = resolveHostCapabilityOptions(options);
        const { bashCompletionCorrelation } = config;
        this.recordSessionBashCompletion = bashCompletionCorrelation.record;
        this.observeLLMRequest = bashCompletionCorrelation.observeLLMRequest;
        this.runtimeConversation = options.runtimeConversation;
        this.reviewPromptDir = identity.reviewPromptDir;
        this.globalEventPublisher =
            options.globalEventPublisher ?? ((event) => this.globalEvents.publish(event));
        this.startupExecutionEnabled = isLocalRuntimeStartupExecutionEnabled(options.startupExecutionPolicy);
        this.capabilityProfile = options.capabilityProfile;
        // MR3: only a host whose channel owner is externally composed (Electron
        // via Local Runtime V2) exposes IM capability. Internal hosts have no IM
        // implementation anymore; the capability gate answers their channel
        // routes with the stable legacy 404 (same body the CLI profile always
        // produced), and agent routes skip the IM wiring below.
        this.channelCapabilityEnabled = identity.channelCapabilityEnabled;
        this.mavisCronAdapterProvider = options.mavisCronAdapterProvider;
        this.deleteAgentCronTasksOverride = options.deleteAgentCronTasks;
        this.runtimeMode = identity.runtimeMode;
        this.capabilities = buildLocalRuntimeCapabilities(this.runtimeMode, options.capabilities);
        this.surfaces = buildLocalRuntimeSurfaceCapabilities(this.runtimeMode);
        this.configGetter = config.configGetter;
        this.shellFamily = resolveHostShellFamily(options.shellFamily);
        this.skipWindowsHardSafetyChecks = readTuiWindowsHardSafetyOptOut(options.runtimeOwnerKind, this.configGetter);
        this.authContextGetter = options.authContextGetter;
        this.authContextInvalidator = options.authContextInvalidator;
        this.routingContextGetter = options.routingContextGetter;
        this.isContextWindowUsageEnabled = config.isContextWindowUsageEnabled;
        this.fetchImpl = options.fetchImpl;
        this.composerSendBehavior = options.composerSendBehavior;
        this.errorReporter = options.errorReporter;
        this.llmRequestFailureHook = config.llmRequestFailureHook;
        this.configUpdater = config.configUpdater;
        this.legacyRuntime = options.legacyOpencodeRuntime;
        this.legacyOpencodeEnabled = options.legacyOpencodeEnabled;
        this.telemetry = options.telemetry;
        this.matrixLogger = options.matrixLogger;
        this.metricsClient = options.metricsClient;
        this.agentRuntimePort = capabilityOptions.agentRuntimePort;
        this.promptSnapshots = options.promptSnapshots;
        this.agentResolver = capabilityOptions.agentResolver;
        this.nowMs = config.nowMs;
        this.cronQueueStore = new LocalMessageQueueStore({
            nowMs: this.nowMs,
            makeId,
            store: options.queuedMessageStore,
            metricsClient: this.metricsClient,
        });
        initializeHostEnvironment({ options, configGetter: this.configGetter, nowMs: this.nowMs });
        this.messageStore = options.messageStore;
        const persistence = createHostSessionPersistence({
            options,
            dataDir: this.configGetter().dataDir,
            nowMs: this.nowMs,
            assertSessionMutationAllowed: (operation) => this.rejectRetiredConversation(`session-controller-${operation}`),
        });
        this.controller = persistence.controller;
        this.modelResolver = resolveHostModelResolver(options, {
            configGetter: this.configGetter,
            authContextGetter: this.authContextGetter,
            routingContextGetter: this.routingContextGetter,
            fetchImpl: this.fetchImpl,
        });
        this.greetingSystemReminderSender = createLocalGreetingSystemReminderSender(this, this.runtimeConversation);
        this.contentSafety = capabilityOptions.contentSafety;
        this.contentSafetyChecker = this.contentSafety.review;
        this.agentName = identity.agentName;
        this.agentDisplayName = identity.agentDisplayName;
        const memory = createLocalMemorySubsystem({
            configGetter: this.configGetter,
            nowMs: this.nowMs,
            emitBusEvent: (type, payload) => this.emitBusEvent(type, payload),
            // Lazy: `lockOwner` is assigned later in this constructor, and the
            // adapter provider only resolves once the v2 Cron bridge is bound.
            cronEnabled: () => this.isCronCapabilityAvailable(),
            // TUI has no user-scoped Memory surface; keep CLI and other hosts unchanged.
            userMemoryEnabled: () => this.isUserMemoryCapabilityAvailable(),
            cliSunsetNotice: options.cliSunsetNotice,
            agentFacts: () => this.agentRuntimePort,
            userConfiguredName: () => this.authContextGetter?.()?.subUserName,
        });
        this.memoryFacade = memory.memoryFacade;
        this.localDataCollector = memory.localDataCollector;
        this.systemReminderService = memory.systemReminderService;
        this.defaultWorkspaceDir = options.defaultWorkspaceDir;
        const workspaceIndexing = createWorkspaceIndexingHostSubsystem({
            ...options,
            dataDir: () => this.configGetter().dataDir,
            nowMs: this.nowMs,
            isEnabled: options.workspaceIndexingEnabled ?? (() => Promise.resolve(false)),
        });
        this.workspaceIndexingStore = workspaceIndexing.store;
        this.workspaceIndexingService = workspaceIndexing.service;
        this.workspaceIndexingRemoteClient = workspaceIndexing.remoteClient;
        this.workspaceIndexingRemoteWorker = workspaceIndexing.remoteWorker;
        this.workspaceSemanticIndexStore = workspaceIndexing.semanticIndexStore;
        this.workspaceSemanticSearchService = workspaceIndexing.semanticSearchService;
        this.createWorkspaceIndexingObservationSink = options.createWorkspaceIndexingObservationSink;
        const stores = resolveHostStores(options, this.configGetter, this.nowMs);
        this.communicationMessageStore = stores.communicationMessageStore;
        this.tokenUsageStore = stores.tokenUsageStore;
        this.turnDiffStore = stores.turnDiffStore;
        this.turnFileChanges = new LocalTurnFileChangeCaptureService(this.turnDiffStore, {
            nowMs: this.nowMs,
            makeId,
            reportFailure: (sessionId, message) => this.reportPiTurnFailure(sessionId, message),
        });
        this.backgroundTaskRuntime = options.createBackgroundTaskRuntime?.(this);
        this.cronStore = stores.cronStore;
        this.questionnaireStore = stores.questionnaireStore;
        this.lockOwner = identity.lockOwner;
        this.useImmediateTaskAdmission = this.resolveImmediateTaskAdmission();
        this.mcpRuntime = options.mcpService;
        this.hookService = createHostHookService({
            options,
            dataDir: () => this.configGetter().dataDir,
            nowMs: this.nowMs,
            resolveWorkspaceDir: () => this.resolveDefaultWorkspaceDir(),
            getSessionById: (sessionId) => this.getSessionById(sessionId),
        });
        for (const registration of this.turnFileChanges.getToolCaptureHookRegistrations()) {
            this.hookService.registry.registerBuiltin(registration);
        }
        this.metrics = options.metricsReporter;
        this.browserBroker =
            options.browserBroker ??
                new LocalBrowserBroker({
                    dataDir: () => this.configGetter().dataDir,
                    nowMs: this.nowMs,
                });
        initializeHostSessionProjections({
            dataDir: () => this.configGetter().dataDir,
            hasMessageStore: Boolean(this.messageStore),
            ensureLegacyMessagesMigrated: (sessionId) => this.legacyMigrator?.ensureMessagesMigrated(sessionId) ?? Promise.resolve(),
            conversation: () => this.requireRuntimeConversation('Session messages'),
            metricsClient: this.metricsClient,
        });
        this.skillRuntime = capabilityOptions.skillRuntime;
        this.pluginHookPermissionStore = capabilityOptions.pluginHookPermissionStore;
        this.channelRuntime = new HostChannelRuntime(options);
        this.hostDiagnosticsProvider = options.hostDiagnosticsProvider;
        this.permissionRules = new LocalPermissionRuleStore(() => this.configGetter().dataDir, this.metricsClient, () => this.configGetter().permission?.storageWriteVersion ?? 2);
        this.permissionApprovalService = this.createPermissionApprovalService();
        this.runtimeStartupToken = options.runtimeStartupToken;
        const history = this.createSessionHistory(options, persistence);
        this.legacyMigrator = history.legacyMigrator;
        this.piHistoryStore = history.piHistoryStore;
        this.agentRoutes = this.createAgentRoutes();
        this.cronRuntime = createHostCronRuntime(this, options, {
            queueStore: this.cronQueueStore,
            lockOwner: this.lockOwner,
            runtimeMode: this.runtimeMode,
            capabilities: this.capabilities,
        });
        this.desktopServiceHandler = buildDesktopHandler(this);
        this.startRecovery(options.deferQuestionnaireRecovery === true);
        this.workspaceIndexingRemoteWorker.start();
    }
    createSessionHistory(options, persistence) {
        return createHostSessionHistory({
            options,
            persistence,
            configGetter: this.configGetter,
            runtimeMode: this.runtimeMode,
            primaryAgentName: this.agentName,
            defaultWorkspaceDir: () => this.resolveDefaultWorkspaceDir(),
            nowMs: this.nowMs,
            tokenUsageStore: this.tokenUsageStore,
        });
    }
    createPermissionApprovalService() {
        return new LocalPermissionApprovalService({
            agentName: this.agentName,
            nowMs: this.nowMs,
            permissionRules: this.permissionRules,
            publishGlobalEvent: (event) => this.publishGlobalEvent(event),
            channelPermissionOutbound: {
                onPermissionAsk: (event) => this.requireChannelPort('permission ask fan-out').permissionOutbound.onPermissionAsk(event),
            },
            metricsClient: this.metricsClient,
            permissionMode: readLocalPermissionMode(this.configGetter().permissionMode),
        });
    }
    startRecovery(deferQuestionnaireRecovery) {
        if (!this.startupExecutionEnabled)
            return;
        if (this.startupExecutionEnabled && this.cronRuntime.cronConsumerEnabled) {
            startHostCronRuntime(this.cronRuntime, (type, payload) => this.emitBusEvent(type, payload));
        }
        if (!deferQuestionnaireRecovery) {
            if (this.channelRuntime.mode !== 'internal') {
                throw new Error('ASSEMBLY_ERROR: questionnaire recovery requires deferQuestionnaireRecovery in external channel composition');
            }
            startQuestionnaireRecovery(this, Promise.resolve());
        }
    }
    resolveImmediateTaskAdmission() {
        const { ownerKind } = this.lockOwner;
        return ((ownerKind === 'electron' && this.capabilities.electronHost === true) ||
            isCliRestrictedRuntime(ownerKind, this.capabilities.cliEmbedded) ||
            (ownerKind === 'app-server' && this.capabilities.cliEmbedded === true));
    }
    createAgentRoutes() {
        return new LocalApiAgentRoutes({
            controller: this.controller,
            ...(this.runtimeConversation ? { conversation: this.runtimeConversation } : {}),
            agentRuntimePort: this.agentRuntimePort,
            legacyMigrator: this.legacyMigrator,
            runtimeMode: this.runtimeMode,
            agentName: this.agentName,
            agentDisplayName: this.agentDisplayName,
            configGetter: this.configGetter,
            nowMs: this.nowMs,
            resolveDefaultWorkspaceDir: () => this.resolveDefaultWorkspaceDir(),
            getLegacyRuntime: () => this.getLegacyRuntime(),
            getSessionById: (id) => this.getSessionById(id),
            listAllSessions: (a, o) => this.listAllSessions(a, o),
            serializeSessions: (s) => hostSerializeSessions(this.sessionStateHost(), s),
            serializeSessionTree: (sessions, url, agentName, getSessionById) => hostSerializeSessionTree(this.sessionStateHost(), sessions, {
                url,
                agentName,
                getSessionById,
            }),
            serializeSession: (s) => hostSerializeSession(this.sessionStateHost(), s),
            isReadOnlyLegacySession: (s) => isReadOnlyLegacySession(this.legacyMigrator, s),
            markMigratedLegacySessionDeleted: (id) => markMigratedLegacySessionDeleted(this.legacyMigrator, id),
            requestCompaction: (s, b) => requestConversationCompaction(this.requireRuntimeConversation('Session compaction'), s, b),
            abortLocalSessionTurn: (id) => this.abortLocalSessionTurn(id),
            normalizeCleanLocalSession: (s) => hostNormalizeCleanLocalSession(this.sessionStateHost(), s),
            publishGlobalEvent: (event) => this.publishGlobalEvent(event),
            ...(this.channelCapabilityEnabled
                ? {
                    routeAgentIm: (a, m) => this.requireChannelPort('agent IM routes').routeAgentIm(a, m),
                    getAgentChannelConfig: (a) => this.requireChannelPort('agent channel config').buildAgentChannelConfig(a),
                }
                : {}),
            resolveLocale: () => resolveLocalRuntimeLocale(),
            metricsReporter: this.metrics,
        });
    }
    supportsInteraction(capability) {
        return this.capabilities[capability];
    }
    bindPromptSnapshots(source) {
        this.promptSnapshots = source;
    }
    bindInternalTurnPromptReads(registry) {
        this.internalTurnPromptReads = registry;
    }
    getPromptSnapshots() {
        return this.promptSnapshots;
    }
    getInternalTurnPromptReads() {
        return this.internalTurnPromptReads;
    }
    buildOwnerTurnToolSources(input) {
        return buildLocalTurnToolSourcesForHost({
            ...input,
            host: this,
            mavisAgentAdapter: createLocalMavisAgentAdapter(this.agentRuntimePort),
            mavisCronAdapter: this.buildOwnerMavisCronAdapter(),
            mavisSessionAdapter: this.buildOwnerMavisSessionAdapter(),
        });
    }
    createHostedAgentCapabilities() {
        return createHostedCapabilities(this, this.lockOwner.ownerKind, this.capabilities.cliEmbedded, this.capabilityProfile);
    }
    createHostedChannelCapabilities() {
        return this.channelRuntime.createHostedCapabilities();
    }
    /** 阻塞依赖（如后台任务）释放后重新驱动该 Session 的队列；对任何 Session 都安全。 */
    wakeSessionQueueAfterDependencyRelease(sessionId) {
        wakeHostSessionQueue({
            conversation: this.runtimeConversation,
            sessionId,
            reportFailure: (failedSessionId, message) => this.reportPiTurnFailure(failedSessionId, message),
        });
    }
    async listChannelSessionIds() {
        return this.requireChannelPort('channel session ids').listBindingSessionIds();
    }
    deleteChannelBindingsForSession(sessionId) {
        return this.requireChannelPort('channel binding cleanup').deleteBindingsBySession(sessionId);
    }
    deleteQuestionnairesForSession(sessionId) {
        return this.questionnaireStore.deleteBySession(sessionId);
    }
    copyPendingQuestionnaireForFork(input) {
        return copyPendingQuestionnaire(this.questionnaireStore, input);
    }
    /** 返回重开问卷的 request id；没有重开时返回 undefined。 */
    async reopenQuestionnaireAfterSafetyRecall(input) {
        const reopened = await reopenQuestionnaire({
            store: this.questionnaireStore,
            nowMs: this.nowMs,
            publishGlobalEvent: (event) => this.publishGlobalEvent(event),
        }, input);
        return reopened?.requestId;
    }
    async deletePermissionStateForSession(sessionId) {
        this.abortLocalSessionPermissions(sessionId);
        this.requireChannelPort('permission session cleanup').forgetPermissionSession(sessionId);
        await this.permissionRules.deleteSession(sessionId);
    }
    copyPermissionStateForFork(input) {
        return this.permissionRules.copySession(input.sourceSessionId, input.targetSessionId);
    }
    inheritSessionPermissionRestrictions(input) {
        return this.permissionRules.inheritSessionRestrictions(input.sourceSessionId, input.targetSessionId);
    }
    /**
     * Bind the local-runtime-v2 Goal owner as the owner of Goal questionnaires.
     * Questionnaire creation, reply and automatic answers ask it about the Goal;
     * the Goal table and policy belong to local-runtime-v2 and are never read here.
     */
    bindQuestionnaireWorkOwner(owner) {
        this.boundQuestionnaireWorkOwner = owner;
    }
    get questionnaireWorkOwner() {
        return this.boundQuestionnaireWorkOwner;
    }
    /**
     * Bind the local-runtime-v2 Goal owner as the receiver of sub-session round
     * attribution: subagent tasks (and the Goal verifier), activated
     * `task_append` rounds, hosted code review children and `session send` rounds
     * started in a descendant Session report which parent Turn asked for them.
     */
    bindSubSessionRoundAttribution(port) {
        this.boundSubSessionRoundAttribution = port;
    }
    get subSessionRoundAttribution() {
        return this.boundSubSessionRoundAttribution;
    }
    hasPendingPermissionForSession(sessionId) {
        return this.permissionApprovalService
            .listPending()
            .some((request) => request.sessionId === sessionId);
    }
    hasActiveTeamOwner(sessionId) {
        return hasActiveLocalTeamOwner(this.configGetter().dataDir, sessionId);
    }
    /**
     * Run one foreground delegation on this host's ordinary task path (hidden
     * child Session, task row, abort plumbing, verdict parsing), on behalf of a
     * caller that owns what the child is asked to do.
     */
    async runForegroundDelegation(input) {
        const { parentSessionId, ...delegation } = input;
        const parentSession = await this.getSessionById(parentSessionId);
        if (!parentSession)
            throw new Error(`Parent Session not found: ${parentSessionId}`);
        return runForegroundLocalTask({ ...delegation, host: this, parentSession });
    }
    buildOwnerMavisCronAdapter() {
        return this.mavisCronAdapterProvider?.();
    }
    /**
     * Mirrors the two conditions `buildLocalTurnToolSourcesForHost` uses to admit
     * `mavisCronAdapter` into a Turn. Kept in sync so reminder guidance never
     * advertises Cron on a host where the tool would answer
     * `CRON_UNSUPPORTED_HOST`.
     */
    isCronCapabilityAvailable() {
        if (isCliRestrictedRuntime(this.lockOwner.ownerKind, this.capabilities.cliEmbedded)) {
            return false;
        }
        return this.buildOwnerMavisCronAdapter() !== undefined;
    }
    isUserMemoryCapabilityAvailable() {
        return this.lockOwner.ownerKind !== 'tui';
    }
    buildOwnerMavisSessionAdapter() {
        return buildHostMavisSessionAdapter(this, this.requireRuntimeConversation('Mavis Session adapter'), {
            serializeSessions: (sessions) => hostSerializeSessions(this.sessionStateHost(), sessions),
            serializeSession: (record) => hostSerializeSession(this.sessionStateHost(), record),
        });
    }
    async deleteSession(sessionId) {
        if (this.runtimeConversation) {
            // The V2 RuntimeConversation is bound to the Session lifecycle that
            // already owns workspace-index cleanup and authoritative Session
            // deletion in one per-Session lane. Wrapping it again here would enqueue
            // the same non-reentrant lane from inside itself and deadlock. Cron and
            // other Host callers must delegate to that single V2 owner unchanged.
            await this.runtimeConversation.lifecycle.deleteSession(sessionId);
            return;
        }
        await this.runWorkspaceIndexingSessionDeletion(sessionId, () => this.controller.deleteSession(sessionId));
    }
    runWorkspaceIndexingSessionDeletion(sessionId, completeSessionDeletion) {
        return this.workspaceIndexingService.deleteSession(sessionId, completeSessionDeletion);
    }
    close() {
        return this.lifecycle.close();
    }
    beginShutdown() {
        this.lifecycle.beginShutdown();
    }
    ensureBuiltinAgents() {
        return this.agentRuntimePort.ensureBuiltinAgents();
    }
    /** Narrow greeting transport reused by V2 AgentApplication; V1 remains only the sender. */
    sendGreetingSystemReminder(input) {
        return this.greetingSystemReminderSender.sendSystemReminder(input);
    }
    deleteAgentCronTasks(agentName) {
        return this.deleteAgentCronTasksOverride
            ? this.deleteAgentCronTasksOverride(agentName)
            : this.cronRuntime.deleteAgentTasks(agentName);
    }
    /** Whitelisted config write access for the DesktopService wiring. */
    updateConfig(body) {
        return this.configUpdater(body);
    }
    /** Session 绑定的执行 Shell 由 owner 解析；权限决策只在 Bash 上读取它。 */
    bindPermissionShellResolver(resolve) {
        resolveLocalPermissionService(this.routeContextHost).bindShellResolver(resolve);
    }
    /** Applies the process-local permission mode and preserves acceptEdits rule seeding. */
    setProcessLocalPermissionMode(mode) {
        return this.permissionModeWriter.write(mode);
    }
    permissionModeWriter = new ProcessLocalPermissionModeWriter({
        configGetter: () => this.configGetter(),
        configUpdater: (body) => this.configUpdater(body),
        syncAcceptEditsSeed: () => resolveLocalPermissionService(this.routeContextHost).syncAcceptEditsSeed(),
        publishGlobalEvent: (event) => this.publishGlobalEvent(event),
    });
    /** Redacted process-local diagnostics owned by this concrete Runtime host. */
    getProcessLocalRuntimeDiagnostics() {
        return this.buildRuntimeDiagnostics(this.configGetter());
    }
    buildRuntimeDiagnostics(config) {
        return buildRuntimeDoctorSnapshot({
            config,
            authContext: this.authContextGetter?.(),
            runtimeMode: this.runtimeMode,
            runtimeOwnerKind: this.lockOwner.ownerKind,
            runtimeOwnerId: this.lockOwner.ownerId,
            runtimeStartupToken: this.runtimeStartupToken,
            capabilities: { ...this.capabilities },
            surfaces: { ...this.surfaces },
            hostDiagnosticsAvailable: Boolean(this.hostDiagnosticsProvider),
        });
    }
    /** Redacted account/model status for process-local product surfaces. */
    async getProcessLocalAccountStatus(sessionId) {
        const baseConfig = this.configGetter();
        const session = sessionId ? await this.getSessionById(sessionId) : undefined;
        const config = session?.effectiveModel
            ? { ...baseConfig, defaultModel: session.effectiveModel }
            : baseConfig;
        return this.buildRuntimeDiagnostics(config);
    }
    retryBuiltinGreetings() {
        return this.agentRuntimePort.retryBuiltinGreetings();
    }
    async handleRequest(request) {
        return routeLocalRuntimeRequest({
            request,
            telemetry: this.telemetry,
            resolveApiPath: (pathname) => {
                return resolveLocalApiHostEntryPath({
                    request,
                    pathname,
                    runtimeStartupToken: this.runtimeStartupToken,
                    desktopServiceHandler: this.desktopServiceHandler,
                });
            },
            routeApi: (req, apiPath, url) => this.routeApi(req, apiPath, url),
        });
    }
    async routeLocalApiRequest(request) {
        return routeLocalRuntimeRequest({
            request,
            telemetry: this.telemetry,
            resolveApiPath: resolveStrictMavisApiPath,
            routeApi: (req, apiPath, url) => this.routeApi(req, apiPath, url),
        });
    }
    routeApi(request, apiPath, url) {
        return routeHostApi({
            runtimeMode: this.runtimeMode,
            capabilities: this.capabilities,
            surfaces: this.surfaces,
            runtimeOwnerKind: this.lockOwner.ownerKind,
            runtimeStartupToken: this.runtimeStartupToken,
            channelCapabilityEnabled: this.channelCapabilityEnabled,
            configGetter: this.configGetter,
            configUpdater: this.configUpdater,
            authContextGetter: this.authContextGetter,
            routingContextGetter: this.routingContextGetter,
            fetchImpl: this.fetchImpl,
            hostDiagnosticsProvider: this.hostDiagnosticsProvider,
            metrics: this.metrics,
            nowMs: this.nowMs,
            communicationMessageStore: this.communicationMessageStore,
            tokenUsageStore: this.tokenUsageStore,
            runtimeConversation: this.runtimeConversation,
            legacyMigrator: this.legacyMigrator,
            contentSafety: this.contentSafety,
            cronRuntime: this.cronRuntime,
            browserBroker: this.browserBroker,
            agentRoutes: this.agentRoutes,
            fileGitChangesCoordinator: this.fileGitChangesCoordinator,
            getSessionById: (id) => this.getSessionById(id),
            listAllSessions: (agent, options) => this.listAllSessions(agent, options),
            getPiHistory: (id) => this.getPiHistory(id),
            ensureLegacyPiHistoryMigrated: (id) => this.ensureLegacyPiHistoryMigrated(id),
            publishGlobalEvent: (event) => this.publishGlobalEvent(event),
            getProcessLocalRuntimeDiagnostics: () => this.getProcessLocalRuntimeDiagnostics(),
            permissionRouteContext: () => this.permissionRouteContext(),
            syncAcceptEditsSeed: () => resolveLocalPermissionService(this.routeContextHost).syncAcceptEditsSeed(),
        }, request, apiPath, url);
    }
    routeContextHost = createHostRouteContext(this);
    permissionRouteContext() {
        return buildPermissionRouteContext(this.routeContextHost);
    }
    questionnaireServiceDeps() {
        return buildQuestionnaireServiceDeps(this.routeContextHost);
    }
    bindQuestionnaireOwnedActionHandler = createQuestionnaireOwnedActionBinder(this.routeContextHost);
    bindQuestionnaireRequestAdmission = createQuestionnaireRequestAdmissionBinder(this.routeContextHost);
    deliverQuestionnaireAskToChannel = (record) => deliverQuestionnaireAskToChannelHelper({
        sendQuestionnaireMessage: (input) => this.requireChannelPort('questionnaire ask delivery').sendQuestionnaireMessage(input),
        emitBusEvent: (type, payload) => this.emitBusEvent(type, payload),
        ...(this.metrics ? { metrics: this.metrics } : {}),
    }, record);
    /** 外部 Channel owner 只允许绑定一次。 */
    bindExternalChannelSubsystem(port) {
        this.channelRuntime.bind(port);
    }
    buildChannelWireInput() {
        return this.channelRuntime.buildWireInput(this);
    }
    requireChannelPort(capability) {
        return this.channelRuntime.require(capability);
    }
    /** Channel owner 负责启动幂等和失败传播。 */
    startChannelSubsystem() {
        return this.requireChannelPort('channel startup').startChannelSubsystem();
    }
    async shutdownChannelSubsystem() {
        await this.requireChannelPort('channel shutdown').shutdownChannelSubsystem();
    }
    rejectRetiredConversation(operation) {
        throw new Error(`Local Runtime V1 Conversation is unavailable: ${operation}`);
    }
    requireRuntimeConversation(operation) {
        if (!this.runtimeConversation) {
            return this.rejectRetiredConversation(operation);
        }
        return this.runtimeConversation;
    }
    isLegacyRuntimeEnabled() {
        return legacyRuntimeEnabledForMode(this.runtimeMode, this.legacyOpencodeEnabled);
    }
    async prepareWorkspaceIndexingForSessionStart(sessionId) {
        return hostPrepareWorkspaceIndexingForSessionStart(this, sessionId);
    }
    prewarmWorkspaceIndexing(workspaceDir) {
        hostPrewarmWorkspaceIndexingForWorkspace(this, workspaceDir);
    }
    closeWorkspaceIndexingPrewarm() {
        this.workspaceIndexingService.closeWorkspacePrewarm();
    }
    /**
     * Capture a workspace revision after a Turn reaches a terminal state. v1 used
     * to call this from its own `notifySessionTurnFinished`; that host hook died
     * with the v1 Session routes, so v2's Turn lifecycle observer now drives it.
     * Failures are swallowed by the implementation — revision capture must never
     * affect the Turn outcome.
     */
    async captureWorkspaceRevisionAfterTurn(sessionId) {
        return hostCaptureWorkspaceRevisionAfterTurn(this, sessionId);
    }
    logWorkspaceSemanticSearchUnavailable(sessionId, error) {
        hostLogWorkspaceSemanticSearchUnavailable(sessionId, error);
    }
    getRuntimeOwnerKind() {
        return this.lockOwner.ownerKind;
    }
    subscribeGlobalEvents(subscriber) {
        return this.globalEvents.subscribe(subscriber);
    }
    publishGlobalEvent(event) {
        if (this.lifecycle.closed)
            return;
        this.globalEventPublisher(event);
    }
    emitBusEvent(type, payload) {
        settleInBackground(handleMemoryBusEvent({
            type,
            payload,
            memoryFacade: this.memoryFacade,
            emitBusEvent: (eventType, eventPayload) => this.emitBusEvent(eventType, eventPayload),
        }));
    }
    async getSessionById(sessionId) {
        return this.requireRuntimeConversation('Session lookup').query.getSession(sessionId);
    }
    async isReadOnlyLegacySession(sessionId) {
        const session = await this.getSessionById(sessionId);
        return isReadOnlyLegacySession(this.legacyMigrator, session ?? sessionId);
    }
    async listAllSessions(agentName, options) {
        return this.requireRuntimeConversation('Session listing').query.listSessions({
            ...(options ?? {}),
            ...(agentName ? { agentName } : {}),
        });
    }
    sessionStateHost() {
        return {
            configGetter: () => ({ ...this.configGetter() }),
            legacyMigrator: this.legacyMigrator,
            readSessionPinned: this.readSessionPinned,
            getSessionById: (id) => this.getSessionById(id),
        };
    }
    getLegacyRuntime() {
        if (!this.isLegacyRuntimeEnabled()) {
            throw new Error('Legacy opencode runtime is disabled in clean local-runtime mode');
        }
        if (!this.legacyRuntime) {
            this.legacyRuntime = new LegacyOpencodeRuntime({
                dataDir: this.configGetter().dataDir,
                enabled: this.isLegacyRuntimeEnabled(),
                fetchImpl: this.fetchImpl,
                telemetry: this.telemetry,
            });
        }
        return this.legacyRuntime;
    }
    resolveDefaultWorkspaceDir() {
        return resolveDefaultLocalWorkspaceDir(this.defaultWorkspaceDir, this.configGetter());
    }
    resolveSessionDefaultWorkspaceDir(sessionId) {
        return join(this.configGetter().dataDir, 'sessions', sessionId, 'workspace');
    }
    abortLocalSessionPermissions(sessionId) {
        abortLocalPermissionRequests(this.permissionRouteContext(), sessionId);
    }
    abortLocalSessionTurn(sessionId) {
        settleInBackground(this.requireRuntimeConversation('Session abort').ingress.abort(sessionId, 'lifecycle'));
        this.abortLocalSessionPermissions(sessionId);
    }
    getPiHistory(sessionId) {
        return this.piHistoryStore.getPiHistory(sessionId);
    }
    async ensureLegacyPiHistoryMigrated(sessionId) {
        await this.legacyMigrator?.ensurePiHistoryMigrated(sessionId);
    }
    reportPiTurnFailure(sessionId, message) {
        this.telemetry?.({ runtime: 'pi-agent', sessionId, phase: 'failure', message });
    }
}
//# sourceMappingURL=host.js.map