import { createDeferredPluginHookPermissionCapability, } from '@mavis/permission';
import { CloudSessionReader, managedBackendRoutingHeaders, resolveLocalBashShell, } from '@mavis/agent-tools/desktop';
import { closeLocalBackgroundTaskDelivery } from '../background-task/delivery.js';
import { join } from 'node:path';
import { getConfig } from '@mavis/config';
import { resolveBuiltinReviewPromptDir } from '../review/preparation.js';
import { ensureCurrentLocalRuntimeDataMigratedToV2OrThrow, hasCompletedV2LayoutMigrationReceipt, } from '../persistence/migration/v2-migration.js';
import { ensureTrashScript, inspectTrashRuntime } from '../infra/ensure-trash-script.js';
import { ensureRmShim } from '../infra/ensure-rm-shim.js';
import { ensureBinInProcessPath } from '../infra/ensure-bin-in-path.js';
import { ensurePathIntegration } from '../infra/ensure-path-integration.js';
import { LocalPermissionRuleStore } from '../permissions/rules.js';
import { LocalPermissionApprovalService } from './local-permission-approval-service.js';
import { resolveLocalPermissionService } from '../permissions/service.js';
import { LocalDynamicMaxTokensState } from '../runtime/dynamic-max-tokens.js';
import { LocalBashCompletionCorrelation, } from '../runtime/bash-completion-correlation.js';
import { createLocalFileApiGitChangesCoordinator, routeLocalFileApi } from '../files/api.js';
import { readBooleanSearchParam } from './host-agent-paging.js';
import { LocalThreadGoalIntegration, } from '../thread-goal/host-integration.js';
import { createThreadGoalEvalEventSink } from '../thread-goal/eval-observability.js';
import { isGoalVerifierChildSession } from '../thread-goal/verifier-session.js';
import { LocalThreadGoalKickoffQueue } from '../thread-goal/kickoff-host.js';
import { createLocalGoalVerifierExecution, } from '../thread-goal/verifier-execution.js';
import { threadGoalContinuationClientRequestId, } from '../thread-goal/kickoff.js';
import { routeLocalConfigApi } from './routes/config.js';
import { routeLocalModelApi } from './routes/models.js';
import { routeLocalWebsiteSettingsApi } from './routes/website-settings.js';
import { routeDebugPiHistoryJsonl as routeDebugPiHistoryJsonlHelper } from './host-debug-pi-history-jsonl.js';
import { routeLocalCommunicationApi } from '../communication/api.js';
import { SqliteLocalCronStore } from '../cron/index.js';
import { buildHostCronRuntime } from './host-cron-runtime.js';
import { buildDesktopServiceHandler as buildDesktopHandler } from './desktop-service-handler.js';
import { buildMavisSessionAdapter } from '../runtime/mavis-tool-adapters.js';
import { createSessionSendWaitGraph, } from '../runtime/mavis-session-send-wait-graph.js';
import { createFailClosedAgentRuntimePort, createLocalMavisAgentAdapter, } from '../agent/runtime-port.js';
import { LocalQuestionnaireService, } from '../questionnaire/service.js';
import { startQuestionnaireRecovery } from '../questionnaire/recovery.js';
import { isLocalRuntimeStartupExecutionEnabled } from '../runtime/startup-execution-policy.js';
import { SqliteQuestionnaireRequestStore } from '../questionnaire/sqlite-questionnaire-request-store.js';
import { QuestionnaireAutoReplyScheduler } from '../questionnaire/auto-reply-scheduler.js';
import { copyPendingQuestionnaireForFork as copyPendingQuestionnaire, } from '../questionnaire/fork.js';
import { LocalHookService } from '../hooks/api.js';
import { LocalBrowserBroker, routeLocalBrowserApi } from '../browser/api.js';
import { createLocalBackgroundTaskService } from '../background-task/index.js';
import { createDeferredContentSafetyCapability, } from '@mavis/shared/local-runtime-safety';
import { createLLMFailureReportHook } from '../error-reporting/index.js';
import { routeLocalContentSafetyApi } from '../content-safety/route.js';
import { buildNoChannelCapabilityPort } from './host-channel-unsupported-port.js';
import { buildHostChannelWireInput, } from './host-channel-composition.js';
import { LocalPiHistoryStore } from './pi-history-store.js';
import { hasActiveLocalTeamOwner, } from '../team/api.js';
import { routeLocalUsageSummaryApi } from '../usage/api.js';
import { LocalTurnFileChangeCaptureService } from '../turns/file-changes.js';
import { updateLocalConfigFile, } from '../config/update.js';
import { InMemoryLocalSessionStore, LocalSessionController, } from '../sessions/controller.js';
import { createLocalModelResolver, createLocalGreetingSystemReminderSender, } from './host-turn-service-factories.js';
import { resolveLocalRuntimeLocale } from '../runtime/locale.js';
import { logger } from '../common/logger.js';
import { LegacyOpencodeRuntime } from '../legacy-opencode/legacy-opencode-runtime.js';
import { LegacyOpencodeStore } from '../legacy-opencode/legacy-opencode-store.js';
import { LegacyOpencodeMigrator } from '../legacy-opencode/legacy-opencode-migrator.js';
import { SqliteLegacyMigrationStore } from '../persistence/migration/legacy-migration-store.js';
import { SqliteLocalCommunicationMessageStore, SqliteLocalTokenUsageStore, SqliteLocalTurnDiffStore, } from '../persistence/sqlite-persistence.js';
import { FileSessionLedgerStore } from '../sessions/ledger/index.js';
import { SqliteLocalSessionProjectionStore, } from '../sessions/projection/index.js';
import { FileSessionSnapshotStore, } from '../sessions/snapshot/index.js';
import { LedgerBackedLocalSessionStore, LiveSessionWriter } from '../sessions/writer/index.js';
import { buildLocalRuntimeSurfaceCapabilities, buildLocalRuntimeCapabilities, legacyRuntimeEnabledForMode, resolveLocalRuntimeMode, } from '../runtime/mode.js';
import { proxyLegacyDaemonApi as proxyLegacyDaemonApiFallback, } from './legacy-fallbacks.js';
import { abortLocalPermissionRequests, routeLocalPermissionApi, } from './routes/permissions.js';
import { buildPermissionRouteContext, buildQuestionnaireServiceDeps, createQuestionnaireOwnedActionBinder, createQuestionnaireRequestAdmissionBinder, } from './host-route-contexts.js';
import { hostNormalizeCleanLocalSession, hostReplyLocalPermissionRequest, hostSerializeSession, hostSerializeSessions, hostSerializeSessionTree, } from './host-session-state.js';
import { requestConversationCompaction } from './routes/compaction.js';
import { deliverQuestionnaireAskToChannel as deliverQuestionnaireAskToChannelHelper } from './host-questionnaire-delivery.js';
import { routeLocalMatrixApi } from '../matrix/index.js';
import { splitPath, json, notFound, readJsonBody, makeId, readLocalPermissionMode, routeDiagnosticsApi, } from './host-helpers.js';
import { observeSteerCompletion } from './conversation-steer.js';
import { mayHaveSetAcceptEditsMode } from './host-model-helpers.js';
import { isReadOnlyLegacySession, markMigratedLegacySessionDeleted, } from './host-legacy-helpers.js';
import { LocalApiAgentRoutes } from './routes/agents.js';
import { buildLocalLegacyMigrationCheck, buildLegacyRuntimeUnavailableResponse, buildLocalRuntimeStatus, buildRuntimeDoctorSnapshot, dispatchLocalTeamTask, formatUnknownError, makeRuntimeOwnerId, routeLocalRuntimeCronApi, resolveDefaultLocalWorkspaceDir, resolveLocalTeamTaskAgentName, } from './host-support.js';
import { resolveLocalApiHostEntryPath, resolveStrictMavisApiPath, routeLocalRuntimeRequest, } from './host-routing.js';
import { buildLocalTurnToolSourcesForHost, } from './host-turn-tools.js';
import { createHostedCapabilities, isCliRestrictedRuntime, } from './hosted-agent-capability-factory.js';
import { handleMemoryBusEvent } from '../memory/local-memory-orchestration.js';
import { createLocalMemorySubsystem } from './host-memory.js';
import { createDeferredSkillRuntimeCapability, } from '@mavis/shared/local-runtime-skills';
import { initSessionFilesService } from '../session-assets/session-files-service.js';
import { initSessionInputSummaryService } from '../session-navigation/service.js';
import { stopBackgroundLocalBashTask } from '../background-task/bash-runner.js';
import { abortAdmittedBackgroundTask, beginBackgroundTaskShutdown, drainBackgroundTasks, } from '../background-task/lifecycle.js';
import { createGlobalEventSource } from '../events/global-events.js';
import { toAgentMessages } from './conversation-message-adapter.js';
import { createWorkspaceIndexingHostSubsystem, hostCaptureWorkspaceRevisionAfterTurn, hostLogWorkspaceSemanticSearchUnavailable, hostPrewarmWorkspaceIndexingForWorkspace, hostPrepareWorkspaceIndexingForSessionStart, } from '../workspace-indexing/index.js';
const DEFAULT_LOCAL_AGENT_NAME = 'mavis';
const DEFAULT_LOCAL_AGENT_DISPLAY_NAME = 'Mavis';
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
    permissionModeUpdate = Promise.resolve();
    modelResolver;
    greetingSystemReminderSender;
    agentName;
    agentDisplayName;
    defaultWorkspaceDir;
    nowMs;
    staleCompactionCutoffMs;
    messageStore;
    ledgerStore;
    sessionWriter;
    projectionStore;
    snapshotStore;
    piHistory = new Map();
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
    backgroundTaskService;
    cronStore;
    threadGoal;
    threadGoalKickoffQueue;
    threadGoalCronOwnerConflictReader;
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
    dynamicMaxTokensState;
    questionnaireStore;
    questionnaireAutoReplyScheduler;
    mcpRuntime;
    get mcpService() {
        if (!this.mcpRuntime)
            throw new Error('MCP runtime is not available on this host');
        return this.mcpRuntime;
    }
    hookService;
    metrics;
    browserBroker;
    /**
     * MR2 two-phase assembly, MR3 endstate: every Channel touchpoint goes
     * through this port. `internal` mode binds the no-IM capability port in
     * the constructor (the v1 package contains no channel implementation);
     * `external` mode leaves it unset until the Local Runtime V2 composition
     * calls {@link bindExternalChannelSubsystem} after its services are
     * assembled. Touchpoints use {@link requireChannelPort} so a missing
     * binding fails loudly as an assembly error instead of a silent no-op.
     */
    channelPort;
    channelCompositionMode;
    /** Retained for {@link buildChannelWireInput}; never mutated after construction. */
    channelWireOptions;
    channelTurnOrigins = new Map();
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
    closed = false;
    closePromise;
    metricsReporter;
    mavisCronAdapterProvider;
    deleteAgentCronTasksOverride;
    fileGitChangesCoordinator = createLocalFileApiGitChangesCoordinator();
    constructor(options = {}) {
        const bashCompletionCorrelation = options.bashCompletionCorrelation ??
            new LocalBashCompletionCorrelation(options.metricsClient);
        this.recordSessionBashCompletion = bashCompletionCorrelation.record;
        this.observeLLMRequest = bashCompletionCorrelation.observeLLMRequest;
        this.runtimeConversation = options.runtimeConversation;
        this.reviewPromptDir = options.reviewPromptDir ?? resolveBuiltinReviewPromptDir();
        this.globalEventPublisher =
            options.globalEventPublisher ?? ((event) => this.globalEvents.publish(event));
        this.startupExecutionEnabled = isLocalRuntimeStartupExecutionEnabled(options.startupExecutionPolicy);
        this.capabilityProfile = options.capabilityProfile;
        // MR3: only a host whose channel owner is externally composed (Electron
        // via Local Runtime V2) exposes IM capability. Internal hosts have no IM
        // implementation anymore; the capability gate answers their channel
        // routes with the stable legacy 404 (same body the CLI profile always
        // produced), and agent routes skip the IM wiring below.
        this.channelCapabilityEnabled =
            (options.channelComposition ?? 'internal') === 'external' && this.capabilityProfile !== 'cli';
        const questionnaireRecoveryDeferred = options.deferQuestionnaireRecovery === true;
        this.mavisCronAdapterProvider = options.mavisCronAdapterProvider;
        this.deleteAgentCronTasksOverride = options.deleteAgentCronTasks;
        this.runtimeMode = options.runtimeMode ?? resolveLocalRuntimeMode();
        this.capabilities = buildLocalRuntimeCapabilities(this.runtimeMode, options.capabilities);
        this.surfaces = buildLocalRuntimeSurfaceCapabilities(this.runtimeMode);
        this.configGetter = options.configGetter ?? (() => getConfig());
        // Use the executor's shell selection when the product entrypoint supplies no override.
        // Keep POSIX provenance on Windows (Git Bash / sh) as well as native shells.
        this.shellFamily =
            options.shellFamily ??
                (() => {
                    const shell = resolveLocalBashShell();
                    if (shell === 'powershell' || shell === 'pwsh')
                        return 'powershell';
                    if (shell === 'bash' || shell === 'sh')
                        return 'posix';
                    return undefined;
                })();
        this.skipWindowsHardSafetyChecks =
            options.runtimeOwnerKind === 'tui' &&
                this.configGetter().skipWindowsHardSafetyChecks === true;
        this.authContextGetter = options.authContextGetter;
        this.authContextInvalidator = options.authContextInvalidator;
        this.routingContextGetter = options.routingContextGetter;
        this.isContextWindowUsageEnabled = options.isContextWindowUsageEnabled ?? (() => false);
        this.fetchImpl = options.fetchImpl;
        this.composerSendBehavior = options.composerSendBehavior;
        this.errorReporter = options.errorReporter;
        this.llmRequestFailureHook =
            options.llmRequestFailureHook ??
                (this.errorReporter ? createLLMFailureReportHook(this.errorReporter) : undefined);
        this.configUpdater = options.configUpdater ?? updateLocalConfigFile;
        this.legacyRuntime = options.legacyOpencodeRuntime;
        this.legacyOpencodeEnabled = options.legacyOpencodeEnabled;
        this.telemetry = options.telemetry;
        this.matrixLogger = options.matrixLogger;
        this.metricsClient = options.metricsClient;
        this.agentRuntimePort = options.agentRuntimePort ?? createFailClosedAgentRuntimePort();
        this.promptSnapshots = options.promptSnapshots;
        this.agentResolver = options.agentResolver ?? this.agentRuntimePort;
        this.nowMs = options.nowMs ?? (() => Date.now());
        this.metricsReporter = options.metricsReporter;
        this.staleCompactionCutoffMs = this.nowMs();
        if (!hasCompletedV2LayoutMigrationReceipt(options, () => this.configGetter().dataDir)) {
            ensureCurrentLocalRuntimeDataMigratedToV2OrThrow(() => this.configGetter().dataDir, this.nowMs, this.metricsReporter);
        }
        const runtimeConfig = this.configGetter();
        const runtimeDataDir = runtimeConfig.dataDir;
        const nativeDelete = runtimeConfig.permission?.nativeDelete === true;
        try {
            // Keep explicit mavis-trash available in either mode.
            ensureTrashScript(runtimeDataDir);
            if (!nativeDelete)
                ensureRmShim(runtimeDataDir);
        }
        catch (error) {
            const nodeError = error instanceof Error ? error : undefined;
            logger.error({
                error: error instanceof Error ? error.message : String(error),
                ...(error instanceof Error ? { error_name: error.name } : {}),
                ...(typeof nodeError?.code === 'string' ? { error_code: nodeError.code } : {}),
                ...(typeof nodeError?.syscall === 'string' ? { syscall: nodeError.syscall } : {}),
            }, 'local_runtime.trash_seed_failed');
        }
        for (const ensure of [ensureBinInProcessPath, ensurePathIntegration]) {
            try {
                ensure(runtimeDataDir);
            }
            catch {
                // PATH integration remains best-effort; deletion safety is gated separately above.
            }
        }
        if (!nativeDelete) {
            const trashRuntime = inspectTrashRuntime(runtimeDataDir);
            if (!trashRuntime.available) {
                logger.error({ reason: trashRuntime.reason, ...trashRuntime.diagnostics }, 'local_runtime.trash_unavailable');
            }
        }
        this.messageStore = options.messageStore;
        const sessionStoreOptions = { nowMs: this.nowMs, metricsClient: options.metricsClient };
        const ledgerStore = options.ledgerStore === false
            ? undefined
            : (options.ledgerStore ??
                new FileSessionLedgerStore(this.configGetter().dataDir, sessionStoreOptions));
        this.ledgerStore = ledgerStore;
        this.projectionStore =
            options.projectionStore ??
                (ledgerStore && this.messageStore
                    ? new SqliteLocalSessionProjectionStore(this.configGetter().dataDir)
                    : undefined);
        this.snapshotStore =
            options.snapshotStore ??
                (ledgerStore && this.messageStore
                    ? new FileSessionSnapshotStore(this.configGetter().dataDir, sessionStoreOptions)
                    : undefined);
        this.sessionWriter =
            options.sessionWriter ??
                new LiveSessionWriter({
                    ledgerStore,
                    messageStore: this.messageStore,
                    projectionStore: this.projectionStore,
                    snapshotStore: this.snapshotStore,
                });
        this.controller =
            options.controller ??
                new LocalSessionController({
                    store: new LedgerBackedLocalSessionStore({
                        delegate: new InMemoryLocalSessionStore(),
                        writer: this.sessionWriter,
                    }),
                    legacyOpencodeEnabled: () => this.isLegacyRuntimeEnabled(),
                    telemetry: options.telemetry,
                    nowMs: this.nowMs,
                    authContextGetter: this.authContextGetter,
                    routingContextGetter: this.routingContextGetter,
                    fetchImpl: this.fetchImpl,
                    ...(this.errorReporter ? { errorReporter: this.errorReporter } : {}),
                    ...(this.llmRequestFailureHook
                        ? { llmRequestFailureHook: this.llmRequestFailureHook }
                        : {}),
                    observeLLMRequest: this.observeLLMRequest,
                    assertTurnStartAllowed: () => this.rejectRetiredConversation('turn-start'),
                    assertSessionMutationAllowed: (operation) => this.rejectRetiredConversation(`session-controller-${operation}`),
                });
        const hostAgentName = options.agentName ?? DEFAULT_LOCAL_AGENT_NAME;
        this.dynamicMaxTokensState = new LocalDynamicMaxTokensState();
        this.modelResolver =
            options.modelResolver ??
                createLocalModelResolver({
                    configGetter: this.configGetter,
                    authContextGetter: this.authContextGetter,
                    routingContextGetter: this.routingContextGetter,
                    dynamicMaxTokensState: this.dynamicMaxTokensState,
                    fetchImpl: this.fetchImpl,
                });
        this.greetingSystemReminderSender = createLocalGreetingSystemReminderSender(this, this.runtimeConversation);
        this.contentSafety =
            options.contentSafety ?? createDeferredContentSafetyCapability().capability;
        this.contentSafetyChecker = this.contentSafety.review;
        this.agentName = hostAgentName;
        this.agentDisplayName = options.agentDisplayName ?? DEFAULT_LOCAL_AGENT_DISPLAY_NAME;
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
        this.communicationMessageStore =
            options.communicationMessageStore ??
                new SqliteLocalCommunicationMessageStore(this.configGetter().dataDir);
        this.tokenUsageStore =
            options.tokenUsageStore ?? new SqliteLocalTokenUsageStore(this.configGetter().dataDir);
        this.turnDiffStore =
            options.turnDiffStore ?? new SqliteLocalTurnDiffStore(this.configGetter().dataDir);
        this.turnFileChanges = new LocalTurnFileChangeCaptureService(this.turnDiffStore, {
            nowMs: this.nowMs,
            makeId,
            reportFailure: (sessionId, message) => this.reportPiTurnFailure(sessionId, message),
        });
        this.backgroundTaskService = createLocalBackgroundTaskService(() => this.configGetter().dataDir, this.nowMs, async (task, reason) => {
            abortAdmittedBackgroundTask(this, task.taskId, reason ?? (task.kind === 'bash' ? 'Background bash stopped' : 'Background task stopped'));
            await stopBackgroundLocalBashTask(task, reason);
            const childSessionId = task.metadata?.childSessionId;
            const subTurnId = task.metadata?.subTurnId;
            if (typeof childSessionId !== 'string' ||
                !childSessionId ||
                typeof subTurnId !== 'string' ||
                !subTurnId) {
                return;
            }
            await this.requireRuntimeConversation('background task abort').ingress.abort(childSessionId, 'lifecycle', subTurnId);
        }, ({ ownerSessionId }) => this.wakeSessionQueueAfterDependencyRelease(ownerSessionId));
        this.cronStore =
            options.cronStore ?? new SqliteLocalCronStore(this.configGetter().dataDir, this.nowMs);
        this.questionnaireStore =
            options.questionnaireStore ??
                new SqliteQuestionnaireRequestStore(() => this.configGetter().dataDir);
        this.questionnaireAutoReplyScheduler = new QuestionnaireAutoReplyScheduler({
            nowMs: this.nowMs,
            run: async (requestId) => {
                const service = new LocalQuestionnaireService(this.questionnaireServiceDeps());
                return service.autoReply(requestId);
            },
            retryDelayMs: 1_000,
        });
        this.lockOwner = {
            ownerId: options.runtimeOwnerId ?? makeRuntimeOwnerId(options.runtimeOwnerKind ?? 'runtime'),
            ownerKind: options.runtimeOwnerKind ?? 'runtime',
        };
        this.useImmediateTaskAdmission =
            (this.lockOwner.ownerKind === 'electron' && this.capabilities.electronHost === true) ||
                isCliRestrictedRuntime(this.lockOwner.ownerKind, this.capabilities.cliEmbedded) ||
                (this.lockOwner.ownerKind === 'app-server' && this.capabilities.cliEmbedded === true);
        this.threadGoalKickoffQueue = new LocalThreadGoalKickoffQueue({
            ...(this.runtimeConversation ? { conversation: this.runtimeConversation } : {}),
            getIntegration: () => this.threadGoal,
            reportFailure: (sessionId, message) => this.reportPiTurnFailure(sessionId, message),
            reportRecoveryFailure: (error) => this.emitBusEvent('thread_goal.kickoff_recovery_failed', { error }),
        });
        this.threadGoal = new LocalThreadGoalIntegration({
            dataDir: () => this.configGetter().dataDir,
            sessionExists: async (sessionId) => Boolean(await this.getSessionById(sessionId)),
            nowMs: this.nowMs,
            turnTimingReader: this.controller.activeTurnTimingReader,
            publishGlobalEvent: (event) => this.publishGlobalEvent(event),
            promptSnapshots: () => this.promptSnapshots,
            hasPendingQuestionnaire: (sessionId, expectedGoalId) => expectedGoalId
                ? new LocalQuestionnaireService(this.questionnaireServiceDeps()).blocksGoalContinuation(sessionId, expectedGoalId)
                : this.questionnaireStore.hasUnresolvedBySession(sessionId),
            retireGoalQuestionnaire: (sessionId, goalId) => new LocalQuestionnaireService(this.questionnaireServiceDeps()).retireGoalQuestionnaire(sessionId, goalId),
            hasPendingPermission: (sessionId) => this.permissionApprovalService
                .listPending()
                .some((request) => request.sessionId === sessionId),
            isGoalVerifierChildSession: async (sessionId) => isGoalVerifierChildSession(await this.getSessionById(sessionId)),
            hasAutomationOwnerConflict: async (sessionId) => (await hasActiveLocalTeamOwner(this.configGetter().dataDir, sessionId)) ||
                (await this.threadGoalCronOwnerConflictReader?.(sessionId)) === true,
            hasRequiredBackgroundWork: async (sessionId) => (await this.backgroundTaskService.list({
                ownerSessionId: sessionId,
                statuses: ['queued', 'running', 'stopping'],
                limit: 1,
            })).items.length > 0,
            startContinuationTurn: async (sessionId, message, displayContent, internalPromptRead) => {
                const conversation = this.requireRuntimeConversation('thread-goal continuation');
                try {
                    const accepted = await conversation.ingress.submit({
                        sessionId,
                        source: 'thread-goal',
                        allowQueue: true,
                        ...(internalPromptRead ? { requestedTurnId: internalPromptRead.requestedTurnId } : {}),
                        message: {
                            ...message,
                            hideUserMessage: true,
                            ...(displayContent ? { displayContent } : {}),
                        },
                    });
                    if (internalPromptRead && accepted.turnId !== internalPromptRead.requestedTurnId) {
                        this.threadGoal.rebindInternalPromptRead(internalPromptRead, accepted.turnId);
                    }
                    return 'started';
                }
                catch (error) {
                    if (internalPromptRead)
                        this.threadGoal.discardInternalPromptRead(internalPromptRead);
                    throw error;
                }
            },
            steerContinuationTurn: async ({ sessionId, message, idempotencyKey, internalPromptRead, onAccepted, }) => {
                const conversation = this.requireRuntimeConversation('thread-goal objective steering');
                try {
                    const result = await conversation.ingress.steer({
                        sessionId,
                        source: 'thread-goal',
                        producerId: 'thread-goal-objective',
                        idempotencyKey,
                        ...(internalPromptRead ? { requestedTurnId: internalPromptRead.requestedTurnId } : {}),
                        message: {
                            content: message.content,
                            attachments: message.attachments.map((attachment) => ({ ...attachment })),
                            origin: message.origin,
                            hideUserMessage: true,
                        },
                        preDelivery: {
                            accept: async (accepted) => {
                                if (internalPromptRead) {
                                    if (accepted.mode === 'activated') {
                                        this.threadGoal.rebindInternalPromptRead(internalPromptRead, accepted.turnId);
                                    }
                                    else {
                                        this.threadGoal.discardInternalPromptRead(internalPromptRead);
                                    }
                                }
                                await onAccepted(accepted);
                            },
                        },
                    });
                    observeSteerCompletion(result, {
                        sessionId,
                        producer: 'Thread Goal objective steering',
                        matrixLogger: this.matrixLogger,
                    });
                    return result;
                }
                catch (error) {
                    if (internalPromptRead)
                        this.threadGoal.discardInternalPromptRead(internalPromptRead);
                    throw error;
                }
            },
            enqueuePostTurnContinuation: (input) => this.enqueueInjectedThreadGoalContinuation(input),
            abortThreadGoalTurn: (sessionId, turnId) => this.requireRuntimeConversation('thread-goal pause').ingress.abort(sessionId, 'thread-goal-paused', turnId),
            internalTurnPromptReads: () => this.internalTurnPromptReads,
            ...this.threadGoalKickoffQueue.integrationDeps(),
            reportFailure: (sessionId, message) => this.reportPiTurnFailure(sessionId, message),
            formatError: formatUnknownError,
            ...(options.threadGoalRuntimeEventSink
                ? { emitRuntimeEvent: options.threadGoalRuntimeEventSink }
                : options.evalReporterFactory
                    ? { emitRuntimeEvent: createThreadGoalEvalEventSink(options.evalReporterFactory) }
                    : {}),
        });
        this.mcpRuntime = options.mcpService;
        this.hookService =
            options.hookService ??
                new LocalHookService({
                    dataDir: () => this.configGetter().dataDir,
                    nowMs: this.nowMs,
                    resolveWorkspaceDir: () => this.resolveDefaultWorkspaceDir(),
                    // Session-exact resolver for built-ins that key derived state by the
                    // directory the session's tools run in. The default resolver above
                    // ignores the sessionId, which mis-keys per-branch recordings (the
                    // review-link status line item) whenever a session runs outside the
                    // host default workspace — a worktree session, a workspace picked in
                    // the TUI, or a runtime shared by several launch directories.
                    resolveSessionWorkspaceDir: async (sessionId) => {
                        try {
                            const session = await this.getSessionById(sessionId);
                            if (!session)
                                return undefined;
                            return session.runLocation?.resolvedDir ?? session.workspaceDir;
                        }
                        catch {
                            // An unresolvable session must skip the recording, not adopt the
                            // host default: a wrong key misattributes the review.
                            return undefined;
                        }
                    },
                    ...(options.metricsReporter ? { metricsReporter: options.metricsReporter } : {}),
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
        initSessionFilesService({
            dataDir: () => this.configGetter().dataDir,
            hasMessageStore: Boolean(this.messageStore),
            ensureLegacyMessagesMigrated: (sessionId) => this.legacyMigrator?.ensureMessagesMigrated(sessionId) ?? Promise.resolve(),
            getDisplayMessages: (sessionId) => this.getDisplayMessages(sessionId),
        });
        initSessionInputSummaryService({
            dataDir: () => this.configGetter().dataDir,
            ensureLegacyMessagesMigrated: (sessionId) => this.legacyMigrator?.ensureMessagesMigrated(sessionId) ?? Promise.resolve(),
            metricsClient: this.metricsClient,
        });
        this.skillRuntime = options.skillRuntime ?? createDeferredSkillRuntimeCapability().capability;
        this.pluginHookPermissionStore =
            options.pluginHookPermissionStore ??
                createDeferredPluginHookPermissionCapability().capability;
        this.channelCompositionMode = options.channelComposition ?? 'internal';
        this.channelWireOptions = options;
        if (this.channelCompositionMode === 'internal') {
            // MR3: the v1 package no longer contains an IM implementation. An
            // `internal` host (embedded CLI/TUI, standalone v1) binds the no-IM
            // capability port: ambient touchpoints (session cleanup, permission
            // fan-out, questionnaire delivery, cron gate) behave exactly like an
            // empty subsystem, IM-only touchpoints fail loudly, and no channel
            // object is ever constructed. Channel HTTP answers with the stable
            // legacy 404 via the capability gate.
            this.channelPort = buildNoChannelCapabilityPort({
                agentName: options.agentName ?? 'mavis',
            });
            logger.info({ agentName: options.agentName ?? 'mavis', mode: 'internal' }, 'Channel subsystem not constructed: internal hosts have no IM capability (MR3)');
        }
        else {
            // MR2 external assembly: the Local Runtime V2 composition owns every
            // Channel store / adapter / runner and binds the port after its own
            // services exist (two-phase assembly, plan §5.2). Nothing is built
            // here on purpose — a v1-owned duplicate would violate the single
            // production owner requirement.
            logger.info({ agentName: options.agentName ?? 'mavis', mode: 'external' }, 'Channel subsystem construction skipped: external composition owns it');
        }
        this.hostDiagnosticsProvider = options.hostDiagnosticsProvider;
        this.permissionRules = new LocalPermissionRuleStore(() => this.configGetter().dataDir, this.metricsClient, () => this.configGetter().permission?.storageWriteVersion ?? 2);
        this.permissionApprovalService = new LocalPermissionApprovalService({
            agentName: this.agentName,
            nowMs: this.nowMs,
            permissionRules: this.permissionRules,
            publishGlobalEvent: (event) => this.publishGlobalEvent(event),
            // Deferred port proxy: in external composition the Channel owner binds
            // AFTER host construction (two-phase assembly). Resolving the port per
            // ask keeps a single fan-out implementation in both modes and turns a
            // pre-binding ask into a loud assembly error instead of a silent drop.
            channelPermissionOutbound: {
                onPermissionAsk: (event) => this.requireChannelPort('permission ask fan-out').permissionOutbound.onPermissionAsk(event),
            },
            metricsClient: this.metricsClient,
            permissionMode: readLocalPermissionMode(this.configGetter().permissionMode),
        });
        this.runtimeStartupToken = options.runtimeStartupToken;
        this.legacyMigrator =
            this.runtimeMode === 'clean' && !this.runtimeConversation
                ? new LegacyOpencodeMigrator({
                    legacyStore: new LegacyOpencodeStore({
                        dataDir: this.configGetter().dataDir,
                        nowMs: this.nowMs,
                    }),
                    migrationStore: new SqliteLegacyMigrationStore(this.configGetter().dataDir),
                    controller: this.controller,
                    messageStore: this.messageStore,
                    sessionWriter: this.sessionWriter,
                    primaryAgentName: this.agentName,
                    defaultWorkspaceDir: () => this.resolveDefaultWorkspaceDir(),
                    dataDir: () => this.configGetter().dataDir,
                    nowMs: this.nowMs,
                    metrics: options.metricsReporter,
                })
                : undefined;
        this.piHistoryStore = new LocalPiHistoryStore({
            ledgerStore: this.ledgerStore,
            snapshotStore: this.snapshotStore,
            messageStore: this.messageStore,
            sessionWriter: this.sessionWriter,
            tokenUsageStore: this.tokenUsageStore,
            legacyMigrator: this.legacyMigrator,
            nowMs: this.nowMs,
            piHistory: this.piHistory,
        });
        this.agentRoutes = new LocalApiAgentRoutes({
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
            proxyLegacyDaemonApi: (...args) => this.proxyLegacyDaemonApi(...args),
            getLegacyRuntime: () => this.getLegacyRuntime(),
            getSessionById: (id) => this.getSessionById(id),
            listAllSessions: (a, o) => this.listAllSessions(a, o),
            serializeSessions: (s) => this.serializeSessions(s),
            serializeSessionTree: (s, u, a, g) => this.serializeSessionTree(s, u, a, g),
            serializeSession: (s) => this.serializeSession(s),
            isReadOnlyLegacySession: (s) => isReadOnlyLegacySession(this.legacyMigrator, s),
            markMigratedLegacySessionDeleted: (id) => markMigratedLegacySessionDeleted(this.legacyMigrator, id),
            requestCompaction: (s, b) => requestConversationCompaction(this.requireRuntimeConversation('Session compaction'), s, b),
            abortLocalSessionTurn: (id) => this.abortLocalSessionTurn(id),
            normalizeCleanLocalSession: (s) => this.normalizeCleanLocalSession(s),
            publishGlobalEvent: (event) => this.publishGlobalEvent(event),
            ...(this.channelCapabilityEnabled
                ? {
                    routeAgentIm: (a, m) => this.requireChannelPort('agent IM routes').routeAgentIm(a, m),
                    getAgentChannelConfig: (a) => this.requireChannelPort('agent channel config').buildAgentChannelConfig(a),
                }
                : {}),
            resolveLocale: () => resolveLocalRuntimeLocale(),
            metricsReporter: options.metricsReporter,
        });
        this.cronRuntime = buildHostCronRuntime(this, async () => new Response(JSON.stringify({ error: 'Runtime Conversation is unavailable' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
        }), options.metricsReporter, this.runtimeConversation ? options.cronConsumerEnabled : false, options.startupExecutionPolicy);
        this.desktopServiceHandler = buildDesktopHandler(this, {
            store: this.threadGoal.store,
            createGoal: (input, createOptions) => this.threadGoal.createGoal(input, createOptions),
            patchGoal: (sessionId, patch) => this.threadGoal.patchGoal(sessionId, patch),
            pauseGoalByUser: (sessionId) => this.threadGoal.pauseGoalByUser(sessionId),
            deleteGoal: (sessionId) => this.threadGoal.deleteGoal(sessionId),
            dismissGoal: (sessionId, goalId) => this.threadGoal.dismissGoal(sessionId, goalId),
            isReadOnlyLegacySession: (sessionId) => this.isReadOnlyLegacySession(sessionId),
        });
        if (this.startupExecutionEnabled && this.cronRuntime.cronConsumerEnabled) {
            void this.cronRuntime.ensureStarted('host_init').catch((err) => {
                this.emitBusEvent('cron.startup_failed', {
                    error: err instanceof Error ? err.message : String(err),
                });
            });
        }
        if (this.startupExecutionEnabled) {
            if (!questionnaireRecoveryDeferred) {
                // MR3: internal hosts have no channel restore pass — recovery runs
                // immediately (pending asks re-render via the no-IM port, which
                // answers `unavailable` exactly like an empty subsystem did).
                // External composition still defers recovery to the v2 milestones.
                if (this.channelCompositionMode !== 'internal') {
                    throw new Error('ASSEMBLY_ERROR: questionnaire recovery requires deferQuestionnaireRecovery in external channel composition');
                }
                startQuestionnaireRecovery(this, Promise.resolve());
            }
            if (!this.runtimeConversation)
                void this.threadGoalKickoffQueue.recover();
        }
        this.workspaceIndexingRemoteWorker.start();
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
    beginHostedTurn(input) {
        this.controller.beginTurnTiming(input.sessionId, input.turnId, input.source);
    }
    checkHostedTurnBudget(input) {
        return this.threadGoal.checkTurnBudget(input);
    }
    async settleHostedTurn(input) {
        this.controller.markTurnTimingSettling(input.sessionId, input.turnId);
        await this.threadGoal.settleInjectedTurn(input);
        this.controller.finishTurnTiming(input.sessionId, input.turnId);
    }
    /**
     * Release the Turn timing frozen for settlement once TurnSystem has spent
     * every settle retry. Without it the session stays `settling` forever, so
     * automatic Goal continuation reads it as busy until a new user Turn or a
     * process restart. Settlement itself must not do this in a `finally`: the
     * first failed attempt is still followed by a retry that needs the timing.
     */
    abandonHostedTurn(input) {
        this.controller.finishTurnTiming(input.sessionId, input.turnId);
    }
    createHostedChannelCapabilities() {
        // The port already accepts the conversation-level channel context, so the
        // capability wrapper no longer converts; both modes share the port's
        // conversion (internal) or the v2 owner's own transport (external).
        return {
            finalReplies: {
                deliver: (input) => this.requireChannelPort('hosted final replies').deliverReplyFromMessages({
                    ctx: input.channelContext,
                    messages: input.messages,
                    sessionId: input.sessionId,
                    ...(input.workspaceDir !== undefined ? { workspaceDir: input.workspaceDir } : {}),
                    ...(input.error !== undefined ? { error: input.error } : {}),
                }),
            },
            typing: {
                start: (input) => this.requireChannelPort('hosted typing').notifyTurnStart(input.channelContext),
                end: (input) => this.requireChannelPort('hosted typing').notifyTurnEnd(input.channelContext),
            },
        };
    }
    /**
     * Re-drive a session's queue after one of its blocking dependencies became
     * non-blocking.
     *
     * The queue dispatcher releases a deferred claim with `drainAgain: false`, so
     * a Goal parked behind a gate has nothing that would ever look at it again —
     * which is exactly why a Goal could sit `active` forever while the user
     * watched it "spin". Dispatching is level-triggered on purpose: it re-runs
     * every gate rather than assuming this particular release unblocked anything,
     * so a session with two outstanding tasks simply defers again until the last
     * one lands.
     *
     * Safe to call for any session: with nothing queued the dispatch is a no-op,
     * the dispatcher already coalesces concurrent wakes, and queue claims plus
     * Turn receipts prevent a duplicate Turn.
     */
    wakeSessionQueueAfterDependencyRelease(sessionId) {
        const conversation = this.runtimeConversation;
        // Unbound during startup reconcile; the Goal kickoff recovery pass that
        // runs after binding re-evaluates those sessions anyway.
        if (!conversation)
            return;
        void conversation.ingress.dispatchQueue(sessionId).catch((error) => {
            this.reportPiTurnFailure(sessionId, `thread_goal_dependency_wake_failed:${formatUnknownError(error)}`);
        });
    }
    async enqueueInjectedThreadGoalContinuation(input) {
        const conversation = this.runtimeConversation;
        if (!conversation)
            throw new Error('Runtime conversation is not bound');
        try {
            const accepted = await conversation.ingress.submit({
                sessionId: input.sessionId,
                source: 'thread-goal',
                allowQueue: true,
                ...(input.internalPromptRead
                    ? { requestedTurnId: input.internalPromptRead.requestedTurnId }
                    : {}),
                message: {
                    ...input.message,
                    hideUserMessage: true,
                },
                clientRequestId: input.clientRequestId ?? threadGoalContinuationClientRequestId(input.turnId),
            });
            if (input.internalPromptRead &&
                accepted.turnId !== input.internalPromptRead.requestedTurnId) {
                this.threadGoal.rebindInternalPromptRead(input.internalPromptRead, accepted.turnId);
            }
            if (!accepted.queue) {
                throw new Error(`Thread Goal continuation submit did not queue: ${input.sessionId}`);
            }
        }
        catch (error) {
            if (input.internalPromptRead) {
                this.threadGoal.discardInternalPromptRead(input.internalPromptRead);
            }
            throw error;
        }
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
    async deleteThreadGoalForSession(sessionId) {
        const goal = await this.threadGoal.store.getBySession(sessionId);
        if (!goal)
            return false;
        await this.threadGoal.store.delete(goal.goalId);
        this.threadGoal.handleChanged({
            type: 'deleted',
            goalId: goal.goalId,
            sessionId,
        });
        return true;
    }
    classifyThreadGoalQueuedItem(item, hasPendingPlan) {
        return this.threadGoal.classifyQueuedItem(item, hasPendingPlan);
    }
    prepareThreadGoalTurnAdmission(input) {
        return this.threadGoal.prepareTurnAdmission(input);
    }
    bindThreadGoalAutomationOwnerConflictReader(reader) {
        this.threadGoalCronOwnerConflictReader = reader;
    }
    bindThreadGoalVerifier(verifier, transcriptWindowReader) {
        this.threadGoal.bindVerifier(verifier, transcriptWindowReader);
    }
    /**
     * Runs the Goal verifier child on this host's ordinary foreground delegation
     * path. The caller owns the per-run counter the child's Turn hooks feed, so
     * the two halves stay in the runtime that hosts each of them.
     */
    createThreadGoalVerifierExecution(registry) {
        return createLocalGoalVerifierExecution(this, registry, {
            onChildStarted: (input) => this.threadGoal.recordVerifierChildStarted(input),
        });
    }
    recoverThreadGoalKickoffs(conversation) {
        if (!this.startupExecutionEnabled)
            return Promise.resolve();
        return this.threadGoalKickoffQueue.recover(conversation);
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
        const conversation = this.requireRuntimeConversation('Mavis Session adapter');
        return buildMavisSessionAdapter({
            cloudReader: new CloudSessionReader({
                authContextGetter: this.authContextGetter ?? (() => undefined),
                authContextInvalidator: this.authContextInvalidator,
                routingHeadersGetter: () => managedBackendRoutingHeaders(this.routingContextGetter?.()),
                fetchImpl: this.fetchImpl,
            }),
            conversation,
            sessionSendWaitGraph: this.sessionSendWaitGraph,
            ...(this.composerSendBehavior ? { getComposerSendBehavior: this.composerSendBehavior } : {}),
            listAllSessions: (agentName, options) => this.listAllSessions(agentName, options),
            getSessionById: (sessionId) => this.getSessionById(sessionId),
            serializeSessions: (sessions) => this.serializeSessions(sessions),
            serializeSession: (record) => this.serializeSession(record),
            updateSession: (sessionId, fields) => conversation.lifecycle.updateSession(sessionId, fields),
            deleteSession: (sessionId) => conversation.lifecycle.deleteSession(sessionId),
            deleteMessageState: () => Promise.resolve(),
            deleteQueuedMessages: () => Promise.resolve(),
            markMigratedLegacySessionDeleted: () => Promise.resolve(false),
            clearRootSessionIf: (sessionId) => this.agentRoutes.clearRootSessionIf(sessionId),
            listDisplayMessages: (sessionId, opts) => this.listDisplayMessages(sessionId, opts),
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
        if (!this.closePromise) {
            this.beginShutdown();
            this.closePromise = this.closeResources();
        }
        return this.closePromise;
    }
    beginShutdown() {
        if (this.closed)
            return;
        this.closed = true;
        this.workspaceIndexingService.closeWorkspacePrewarm();
        closeLocalBackgroundTaskDelivery(this);
        beginBackgroundTaskShutdown(this, 'runtime-shutdown');
    }
    async closeResources() {
        let firstError;
        const cleanups = [
            () => this.questionnaireAutoReplyScheduler.close(),
            () => this.globalEvents.close(),
            () => this.workspaceIndexingRemoteWorker.close(),
            () => drainBackgroundTasks(this),
            () => this.errorReporter?.close(),
        ];
        for (const close of cleanups) {
            try {
                await close();
            }
            catch (error) {
                firstError ??= error;
            }
        }
        if (firstError !== undefined)
            throw firstError;
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
    bindPermissionShellResolver(resolve) {
        resolveLocalPermissionService(this).bindShellResolver(resolve);
    }
    /** Applies the process-local permission mode and preserves acceptEdits rule seeding. */
    setProcessLocalPermissionMode(mode) {
        const update = this.permissionModeUpdate.then(() => this.applyProcessLocalPermissionMode(mode));
        // Serialise profile-mode writes so each committed transition has the
        // preceding effective value, including concurrent writes from clients.
        this.permissionModeUpdate = update.then(() => undefined, () => undefined);
        return update;
    }
    async applyProcessLocalPermissionMode(mode) {
        const previousMode = this.configGetter().permissionMode;
        const { config } = await this.configUpdater({
            field: 'permissionMode',
            set: mode,
        });
        if (mode === 'acceptEdits') {
            await resolveLocalPermissionService(this).syncAcceptEditsSeed();
        }
        if (config.permissionMode && previousMode !== config.permissionMode) {
            this.publishGlobalEvent({
                type: 'config.permission_mode.changed',
                payload: { permissionMode: config.permissionMode },
            });
        }
        return config.permissionMode;
    }
    /** Redacted process-local diagnostics owned by this concrete Runtime host. */
    getProcessLocalRuntimeDiagnostics() {
        return buildRuntimeDoctorSnapshot({
            config: this.configGetter(),
            authContext: this.authContextGetter?.(),
            runtimeMode: this.runtimeMode,
            runtimeOwnerKind: this.lockOwner.ownerKind,
            runtimeOwnerId: this.lockOwner.ownerId,
            runtimeStartupToken: this.runtimeStartupToken,
            capabilities: this.capabilities,
            surfaces: this.surfaces,
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
        const authContext = this.authContextGetter?.();
        const doctor = buildRuntimeDoctorSnapshot({
            config,
            authContext,
            runtimeMode: this.runtimeMode,
            runtimeOwnerKind: this.lockOwner.ownerKind,
            runtimeOwnerId: this.lockOwner.ownerId,
            runtimeStartupToken: this.runtimeStartupToken,
            capabilities: this.capabilities,
            surfaces: this.surfaces,
            hostDiagnosticsAvailable: Boolean(this.hostDiagnosticsProvider),
        });
        return {
            ...doctor,
        };
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
    async routeApi(request, apiPath, url) {
        const method = request.method.toUpperCase();
        const parts = splitPath(apiPath);
        if (!this.channelCapabilityEnabled && isChannelCapabilityRoute(parts)) {
            return notFound(apiPath);
        }
        if (parts[0] === 'runtime' && parts[1] === 'capabilities' && method === 'GET') {
            return json({
                mode: this.runtimeMode,
                capabilities: this.capabilities,
                surfaces: this.surfaces,
            });
        }
        if (parts[0] === 'runtime' && parts[1] === 'status' && method === 'GET') {
            return json(buildLocalRuntimeStatus({
                runtimeMode: this.runtimeMode,
                runtimeOwnerKind: this.lockOwner.ownerKind,
                capabilities: this.capabilities,
                surfaces: this.surfaces,
                config: this.configGetter(),
                runtimeStartupToken: this.runtimeStartupToken,
            }));
        }
        if (parts[0] === 'runtime' && parts[1] === 'doctor' && method === 'GET') {
            return json(buildRuntimeDoctorSnapshot({
                config: this.configGetter(),
                authContext: this.authContextGetter?.(),
                runtimeMode: this.runtimeMode,
                runtimeOwnerKind: this.lockOwner.ownerKind,
                runtimeOwnerId: this.lockOwner.ownerId,
                runtimeStartupToken: this.runtimeStartupToken,
                capabilities: this.capabilities,
                surfaces: this.surfaces,
                hostDiagnosticsAvailable: Boolean(this.hostDiagnosticsProvider),
            }));
        }
        if (parts[0] === 'runtime' &&
            parts[1] === 'migration' &&
            parts[2] === 'check' &&
            method === 'GET') {
            return json(await buildLocalLegacyMigrationCheck({
                runtimeMode: this.runtimeMode,
                dataDir: this.configGetter().dataDir,
                agentName: url.searchParams.get('agentName') ?? undefined,
                verbose: readBooleanSearchParam(url, 'verbose'),
                legacyMigrator: this.legacyMigrator,
            }));
        }
        if (parts[0] === 'config' || parts.join('/') === 'external/llm-provider-discovery') {
            const configRouteResponse = await routeLocalConfigApi({
                configGetter: this.configGetter,
                configUpdater: this.configUpdater,
                publishGlobalEvent: (event) => this.publishGlobalEvent(event),
                permissionSeedRunner: async (body) => {
                    if (!mayHaveSetAcceptEditsMode(body))
                        return;
                    await resolveLocalPermissionService(this).syncAcceptEditsSeed();
                },
            }, request, method, parts);
            if (configRouteResponse)
                return configRouteResponse;
        }
        const modelRouteResponse = await routeLocalModelApi({
            configGetter: this.configGetter,
            configUpdater: this.configUpdater,
            getSessionById: (sessionId) => this.getSessionById(sessionId),
            conversation: this.runtimeConversation,
            onDefaultModelChanged: () => { },
        }, request, method, parts, url);
        if (modelRouteResponse)
            return modelRouteResponse;
        if (parts[0] === 'permission') {
            return routeLocalPermissionApi(this.permissionRouteContext(), method, request, parts, url);
        }
        if (parts[0] === 'content') {
            return routeLocalContentSafetyApi({
                safety: this.contentSafety,
                request,
                method,
                parts,
                configGetter: this.configGetter,
                authContextGetter: this.authContextGetter,
                routingContextGetter: this.routingContextGetter,
                fetch: this.fetchImpl,
            });
        }
        if (parts[0] === 'cron') {
            return routeLocalRuntimeCronApi({
                runtime: this.cronRuntime,
                listAllSessions: (agentName, options) => this.listAllSessions(agentName, options),
                method,
                request,
                parts,
            });
        }
        if (parts[0] === 'browser')
            return routeLocalBrowserApi({ request, method, parts, broker: this.browserBroker });
        if (parts[0] === 'matrix') {
            return routeLocalMatrixApi({
                request,
                method,
                parts,
                ...(this.authContextGetter ? { authContextGetter: this.authContextGetter } : {}),
                ...(this.routingContextGetter ? { routingContextGetter: this.routingContextGetter } : {}),
                fetchImpl: this.fetchImpl,
            });
        }
        // MR3: the legacy channel HTTP surface (`channel/connections`,
        // `channel-bridge`/`im-bridge`, `lark/onboard`, `channel-route`) is
        // served by the Local Runtime V2 front door (`http/routing/channel-compat`)
        // on hosts that composed the channel owner. Requests that still reach
        // this router (hosts without the owner, or direct v1 dispatch) fall to
        // the terminal `notFound(apiPath)` below — the same stable legacy 404
        // the capability gate has always produced for no-IM hosts.
        if (parts[0] === 'diagnostics') {
            return routeDiagnosticsApi(this.hostDiagnosticsProvider, request, parts);
        }
        if (method === 'GET' &&
            parts[0] === 'debug' &&
            parts[1] === 'session' &&
            parts[2] &&
            parts[3] === 'pi-history.jsonl') {
            return routeDebugPiHistoryJsonlHelper(this, parts[2]);
        }
        if (parts[0] === 'usage' &&
            method === 'GET' &&
            (parts.length === 1 || parts[1] === 'summary')) {
            return routeLocalUsageSummaryApi({ usageStore: this.tokenUsageStore, url });
        }
        if (parts[0] === 'drive')
            return routeLocalWebsiteSettingsApi({
                request,
                method,
                parts,
                ...(this.authContextGetter ? { authContextGetter: this.authContextGetter } : {}),
                ...(this.routingContextGetter ? { routingContextGetter: this.routingContextGetter } : {}),
                ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
            });
        if (parts[0] === 'file' || parts[0] === 'fs') {
            return ((await routeLocalFileApi(request, parts, url, this.metrics, this.fileGitChangesCoordinator)) ?? notFound(apiPath));
        }
        if (parts[0] === 'communication') {
            return await routeLocalCommunicationApi({
                request,
                method,
                parts,
                nowMs: this.nowMs,
                getSessionById: (sessionId) => this.getSessionById(sessionId),
                listAllSessions: (agentName) => this.listAllSessions(agentName),
                communicationMessageStore: this.communicationMessageStore,
                ...(this.runtimeConversation ? { conversation: this.runtimeConversation } : {}),
            });
        }
        if (method === 'GET' && parts[0] === 'agent' && parts[1] === 'session' && parts[2]) {
            return this.agentRoutes.routeAgentSessionLookup(parts[2]);
        }
        if (method === 'POST' && parts[0] === 'agent' && parts.length === 1) {
            // Legacy create endpoint is transport-compatible, but its write now
            // crosses the injected V2 Agent port; no local_runtime_agents row is
            // created in this host.
            return this.agentRoutes.createLocalAgent(await readJsonBody(request));
        }
        if (parts[0] === 'agent' && parts[1] && parts.length > 2) {
            return await this.agentRoutes.routeAgentApi(request, parts, url);
        }
        if (parts[0] === 'session') {
            return json({ error: 'Local Runtime V1 Conversation is unavailable' }, { status: 503 });
        }
        return notFound(apiPath);
    }
    permissionRouteContext() {
        return buildPermissionRouteContext(this);
    }
    questionnaireServiceDeps() {
        return buildQuestionnaireServiceDeps(this);
    }
    bindQuestionnaireOwnedActionHandler = createQuestionnaireOwnedActionBinder(this);
    bindQuestionnaireRequestAdmission = createQuestionnaireRequestAdmissionBinder(this);
    deliverQuestionnaireAskToChannel = (record) => deliverQuestionnaireAskToChannelHelper({
        sendQuestionnaireMessage: (input) => this.requireChannelPort('questionnaire ask delivery').sendQuestionnaireMessage(input),
        emitBusEvent: (type, payload) => this.emitBusEvent(type, payload),
        ...(this.metrics ? { metrics: this.metrics } : {}),
    }, record);
    /**
     * MR2 two-phase assembly, phase 2: the Local Runtime V2 composition binds
     * the v2-owned Channel subsystem exactly once after its services exist.
     * Rebinding or binding over an internal subsystem is an assembly bug and
     * fails loudly (single-owner invariant, plan §5.1/§5.2).
     */
    bindExternalChannelSubsystem(port) {
        if (this.channelCompositionMode !== 'external') {
            throw new Error('ASSEMBLY_ERROR: bindExternalChannelSubsystem requires channelComposition "external"');
        }
        if (this.channelPort) {
            throw new Error('ASSEMBLY_ERROR: the external channel subsystem is already bound');
        }
        this.channelPort = port;
        logger.info({ agentName: this.agentName, mode: 'external' }, 'External channel subsystem bound to the v1 host facade');
    }
    /**
     * One authoritative host capability bundle for channel assembly (MR2).
     * The external composition (Local Runtime V2) feeds this straight into its
     * own `wireChannelSubsystem` copy, so internal and external assemblies can
     * never drift: both consume the exact same session / agent / questionnaire
     * / permission closures.
     */
    buildChannelWireInput() {
        return buildHostChannelWireInput(this, this.channelWireOptions);
    }
    /** Loud assembly-error accessor for every Channel touchpoint. */
    requireChannelPort(capability) {
        if (!this.channelPort) {
            throw new Error(`ASSEMBLY_ERROR: the channel subsystem port is not bound (needed for ${capability}; mode=${this.channelCompositionMode})`);
        }
        return this.channelPort;
    }
    /**
     * Run the channel subsystem startup once: legacy IM credential import →
     * ordered pre-restore steps → exactly one `restoreInboundLoops()`.
     *
     * The V2 composition owns construction, startup and shutdown; this host only
     * delegates through the bound port. Concurrent starts share one execution.
     * Owner runtimes trigger it after builtin Agent definitions become ready and
     * report failures as detached Channel recovery errors. Non-owner runtimes
     * still await it and fail startup on rejection (see runtime.ts).
     */
    startChannelSubsystem() {
        return this.requireChannelPort('channel startup').startChannelSubsystem();
    }
    async shutdownChannelSubsystem() {
        await this.requireChannelPort('channel shutdown').shutdownChannelSubsystem();
    }
    async proxyLegacyDaemonApi(request, apiPath, url, root, fallback) {
        if (!this.isLegacyRuntimeEnabled()) {
            if (fallback)
                return fallback();
            return this.legacyRuntimeUnavailable(root, apiPath);
        }
        return proxyLegacyDaemonApiFallback({
            request,
            apiPath,
            url,
            root,
            legacyRuntime: this.getLegacyRuntime(),
            fallback,
        });
    }
    legacyRuntimeUnavailable(root, apiPath) {
        return buildLegacyRuntimeUnavailableResponse({
            root,
            apiPath,
            runtimeMode: this.runtimeMode,
        });
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
        if (this.closed)
            return;
        this.globalEventPublisher(event);
    }
    emitBusEvent(type, payload) {
        void handleMemoryBusEvent({
            type,
            payload,
            memoryFacade: this.memoryFacade,
            emitBusEvent: (eventType, eventPayload) => this.emitBusEvent(eventType, eventPayload),
        });
    }
    async getSessionById(sessionId) {
        return this.requireRuntimeConversation('Session lookup').query.getSession(sessionId);
    }
    async isReadOnlyLegacySession(sessionId) {
        const session = await this.getSessionById(sessionId);
        return isReadOnlyLegacySession(this.legacyMigrator, session ?? sessionId);
    }
    async dispatchLocalTeamTask(input) {
        const conversation = this.requireRuntimeConversation('Team task dispatch');
        return dispatchLocalTeamTask({
            task: input,
            teamDefaultModelConfigId: this.configGetter().agents?.default.modelConfigId,
            resolveAgentName: (requestedAgent, fallbackAgentName) => this.resolveLocalTeamTaskAgentName(requestedAgent, fallbackAgentName),
            createSession: (sessionInput) => this.agentRoutes.createSession(sessionInput),
            resolveDefaultWorkspaceDir: () => this.resolveDefaultWorkspaceDir(),
            enqueue: async (session, body) => {
                const accepted = await conversation.ingress.submit({
                    sessionId: session.sessionId,
                    source: 'team',
                    allowQueue: true,
                    message: { ...body, attachments: [] },
                });
                return accepted.queue ? { itemId: accepted.queue.itemId } : undefined;
            },
        });
    }
    async resolveLocalTeamTaskAgentName(requestedAgent, fallbackAgentName) {
        return resolveLocalTeamTaskAgentName({
            requestedAgent,
            fallbackAgentName,
            primaryAgentName: this.agentName,
            primaryAgentDisplayName: this.agentDisplayName,
            listLocalAgents: () => this.agentRoutes.listLocalAgents(),
        });
    }
    async cancelLocalTeamTask(input) {
        const conversation = this.requireRuntimeConversation('Team task cancellation');
        const queueCancelled = input.queueItemId
            ? Boolean(await conversation.ingress.cancelQueued(input.sessionId, input.queueItemId))
            : false;
        const turnAborted = await conversation.ingress.abort(input.sessionId, 'lifecycle');
        return { sessionId: input.sessionId, queueCancelled, turnAborted };
    }
    async listAllSessions(agentName, options) {
        return this.requireRuntimeConversation('Session listing').query.listSessions({
            ...(options ?? {}),
            ...(agentName ? { agentName } : {}),
        });
    }
    async normalizeCleanLocalSession(session) {
        return hostNormalizeCleanLocalSession(this, session);
    }
    async replyLocalPermissionRequest(requestId, decision) {
        return hostReplyLocalPermissionRequest(requestId, decision, this.permissionRouteContext());
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
    async serializeSessions(sessions) {
        return hostSerializeSessions(this, sessions);
    }
    async serializeSessionTree(sessions, url, agentName, getSessionById = (sessionId) => this.getSessionById(sessionId)) {
        return hostSerializeSessionTree(this, sessions, url, agentName, getSessionById);
    }
    async serializeSession(session) {
        return hostSerializeSession(this, session);
    }
    abortLocalSessionPermissions(sessionId) {
        abortLocalPermissionRequests(this.permissionRouteContext(), sessionId);
    }
    abortLocalSessionTurn(sessionId) {
        void this.requireRuntimeConversation('Session abort')
            .ingress.abort(sessionId, 'lifecycle')
            .catch(() => undefined);
        this.abortLocalSessionPermissions(sessionId);
    }
    async getDisplayMessages(sessionId) {
        const page = await this.requireRuntimeConversation('Session messages').query.listMessages(sessionId, {
            limit: 10_000,
        });
        return toAgentMessages(page.messages);
    }
    async listDisplayMessages(sessionId, opts) {
        const page = await this.requireRuntimeConversation('Session messages').query.listMessages(sessionId, opts);
        return {
            messages: toAgentMessages(page.messages),
            hasMore: page.hasMore,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
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
function isChannelCapabilityRoute(parts) {
    if (parts[0] === 'channel-bridge' ||
        parts[0] === 'im-bridge' ||
        parts[0] === 'channel-route' ||
        (parts[0] === 'channel' && parts[1] === 'connections')) {
        return true;
    }
    if (parts[0] === 'lark' && parts[1] === 'onboard')
        return true;
    return parts[0] === 'agent' && parts[2] === 'im';
}
//# sourceMappingURL=host.js.map