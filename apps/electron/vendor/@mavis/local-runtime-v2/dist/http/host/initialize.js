import { getConfig } from '@mavis/config';
import { LocalRuntimeApiHost } from './host.js';
import { copyV2LayoutMigrationReceipt } from '../../infra/legacy-db/v2-migration.js';
import { withEffectiveAdvisorConfig } from '../../infra/config/effective-advisor.js';
import { withEffectiveBunnyConfig } from '../../infra/config/effective-bunny.js';
import { withEffectivePromptSuggestionConfig } from '../../infra/config/effective-prompt-suggestion.js';
import { updateLocalConfigFile } from '../../infra/config/update.js';
import { logger } from '../../infra/logging/logger.js';
import { LocalEvalReporterFactory } from '../../service/session-clio/index.js';
import { createDesktopErrorReporter, createLLMFailureReportHook, } from '../../infra/error-reporting/index.js';
import { LocalSessionController } from '../../service/session-system/index.js';
import { createLocalRuntimeTelemetrySink, createMatrixToolLogger, createObservabilityEventSink, JsonlFileObservabilitySink, } from '../../infra/observability/index.js';
import { formatV2TimestampParts, resolveV2EventDir } from '../../infra/legacy-db/v2-paths.js';
import { SqliteLocalMessageStore, SqliteLocalQueueStore, SqliteLocalSessionStore, } from '../../infra/legacy-db/sqlite-persistence.js';
import { FileSessionLedgerStore } from '../../infra/file/session-ledger.js';
import { SqliteLocalSessionProjectionStore } from '../../infra/file/session-projection.js';
import { FileSessionSnapshotStore } from '../../infra/file/session-snapshot.js';
import { LedgerBackedLocalSessionStore, LiveSessionWriter, } from '../../infra/file/session-writer.js';
import { buildLocalRuntimeMetricsClient } from '../../infra/observability/host-metrics.js';
import { LocalBashCompletionCorrelation } from '../../infra/observability/bash-completion-correlation.js';
import { composeTelemetrySinks, createLocalRuntimeMetricsReporter, } from '../../infra/observability/host-wiring.js';
export function createLocalRuntimeHost(options) {
    const { dataDir, nowMs } = options;
    // Expose resolved dataDir so skill content template variables
    // ({{DATA_DIR}}) resolve correctly regardless of entry point
    // (Electron, CLI, daemon).
    process.env.MINIMAX_DATA_DIR = dataDir;
    const { observability, telemetry, metricsClient, evalReporterFactory, errorReporter, llmRequestFailureHook, bashCompletionCorrelation, metricsReporter, } = createHostTelemetry(options);
    const { configGetter, configUpdater } = resolveHostConfig(options, metricsClient);
    // Agent state is owned by the composed Agent service. This compatibility
    // factory only constructs Session/queue and other local runtime stores.
    const messageStore = new SqliteLocalMessageStore(dataDir);
    const ledgerStore = new FileSessionLedgerStore(dataDir, { metricsClient });
    const projectionStore = new SqliteLocalSessionProjectionStore(dataDir);
    const snapshotStore = new FileSessionSnapshotStore(dataDir, { metricsClient });
    const sessionWriter = new LiveSessionWriter({
        ledgerStore,
        messageStore,
        projectionStore,
        snapshotStore,
    });
    const sessionStore = new LedgerBackedLocalSessionStore({
        delegate: new SqliteLocalSessionStore(dataDir),
        writer: sessionWriter,
    });
    const queuedMessageStore = new SqliteLocalQueueStore(dataDir);
    const legacyOpencodeEnabled = options.legacyOpencodeEnabled ?? false;
    const controller = new LocalSessionController({
        store: sessionStore,
        nowMs,
        ...(evalReporterFactory ? { evalReporterFactory } : {}),
        assertSessionMutationAllowed: (operation) => assertConversationUnavailable(`session-controller-${operation}`),
    });
    const apiHostOptions = copyV2LayoutMigrationReceipt(options, {
        controller,
        messageStore,
        ledgerStore,
        projectionStore,
        snapshotStore,
        sessionWriter,
        queuedMessageStore,
        runtimeMode: options.runtimeMode,
        capabilities: options.capabilities,
        shellFamily: options.shellFamily,
        capabilityProfile: options.capabilityProfile,
        mavisCronAdapterProvider: options.mavisCronAdapterProvider,
        deleteAgentCronTasks: options.deleteAgentCronTasks,
        cronConsumerEnabled: options.cronConsumerEnabled,
        runtimeConversation: options.runtimeConversation,
        reviewPromptDir: options.reviewPromptDir,
        deferChannelStartup: options.deferChannelStartup,
        channelComposition: options.channelComposition,
        globalEventPublisher: options.globalEventPublisher,
        agentResolver: options.agentResolver,
        agentRuntimePort: options.agentRuntimePort,
        promptSnapshots: options.promptSnapshots,
        disableLegacyConversation: options.disableLegacyConversation,
        deferQuestionnaireRecovery: options.deferQuestionnaireRecovery,
        workspaceIndexingEnabled: options.workspaceIndexingEnabled,
        composerSendBehavior: options.composerSendBehavior,
        createBackgroundTaskRuntime: options.createBackgroundTaskRuntime,
        runLegacyImCredentialMigration: options.runLegacyImCredentialMigration,
        runtimeOwnerKind: options.runtimeOwnerKind,
        runtimeStartupToken: options.runtimeStartupToken,
        startupExecutionPolicy: options.startupExecutionPolicy,
        configGetter,
        modelResolver: options.modelResolver,
        authContextGetter: options.authContextGetter,
        authContextInvalidator: options.authContextInvalidator,
        routingContextGetter: options.routingContextGetter,
        isContextWindowUsageEnabled: options.isContextWindowUsageEnabled,
        fetchImpl: options.fetchImpl,
        errorReporter,
        llmRequestFailureHook,
        bashCompletionCorrelation,
        configUpdater,
        hostDiagnosticsProvider: options.hostDiagnosticsProvider,
        remoteSessionHost: options.remoteSessionHost,
        skillRegistryDiagnostics: options.skillRegistryDiagnostics,
        skillEnabledState: options.skillEnabledState,
        skillRuntime: options.skillRuntime,
        pluginHookPermissionStore: options.pluginHookPermissionStore,
        mergeRequests: options.mergeRequests,
        contentSafety: options.contentSafety,
        cliSunsetNotice: options.cliSunsetNotice,
        defaultWorkspaceDir: options.defaultWorkspaceDir,
        legacyOpencodeEnabled,
        telemetry,
        ...(evalReporterFactory ? { evalReporterFactory } : {}),
        matrixLogger: createMatrixToolLogger(observability),
        nowMs,
        metricsReporter,
        metricsClient,
        getCollectionPolicy: options.getCollectionPolicy,
        ptcDefault: options.ptcDefault,
        createWorkspaceIndexingObservationSink: options.createWorkspaceIndexingObservationSink,
        ...(options.mcpRuntime ? { mcpService: options.mcpRuntime } : {}),
        ...(options.wechatRuntimeSdk ? { wechatRuntimeSdk: options.wechatRuntimeSdk } : {}),
    });
    const apiHost = new LocalRuntimeApiHost(apiHostOptions);
    if (options.sandboxOperationsFactory) {
        const buildOwnerTurnToolSources = apiHost.buildOwnerTurnToolSources.bind(apiHost);
        apiHost.buildOwnerTurnToolSources = (input) => buildOwnerTurnToolSources({
            ...input,
            sandboxOperationsFactory: options.sandboxOperationsFactory,
        });
    }
    const ready = Promise.resolve();
    const handleRequest = apiHost.handleRequest.bind(apiHost);
    apiHost.handleRequest = async (request) => {
        await ready;
        return handleRequest(request);
    };
    return {
        apiHost,
        controller,
        dataDir,
        ready,
        metricsClient,
        observability,
        ...(evalReporterFactory ? { evalReporterFactory } : {}),
    };
}
function resolveHostConfig(options, metricsClient) {
    // Every config this host hands out carries the effective prompt-suggestion
    // and Next Step opt-ins, the effective Bunny beta switch and the advisor switch.
    const effective = withEffectiveBunnyConfig({
        ...withEffectivePromptSuggestionConfig({
            configGetter: options.configGetter ?? (() => getConfig()),
            configUpdater: options.configUpdater ?? updateLocalConfigFile,
            getPromptSuggestionPolicy: options.getPromptSuggestionPolicy,
        }),
        getBunnyPolicy: options.getBunnyPolicy,
        getUserId: () => options.authContextGetter?.()?.realUserID,
        ...(options.bunnyBuildVariant ? { buildVariant: options.bunnyBuildVariant } : {}),
        metricsClient,
    });
    const config = withEffectiveAdvisorConfig(effective);
    // Read the warnings off the config this host actually runs on, not off the
    // global `getConfig()`. Both product entries derive their getter from
    // `getConfig()`, so a clamped `goal` key still surfaces here; tests that
    // inject a hand-built config carry no warnings and stay silent without this
    // needing to know whether the getter was injected.
    const parsed = config.configGetter();
    for (const warning of parsed.goalWarnings ?? []) {
        logger.warn({ warning }, 'Goal config fell back to a safe default');
    }
    // The shared config parser cannot log (the interactive TUI draws on the same terminal).
    for (const warning of parsed.agents?.warnings ?? []) {
        logger.warn({ warning }, 'Agent capability config ignored unknown IDs');
    }
    return config;
}
function createHostTelemetry(options) {
    const { dataDir, nowMs } = options;
    const runtimeNowMs = nowMs ?? (() => Date.now());
    const observability = options.observability ??
        createObservabilityEventSink({
            component: 'local-runtime',
            context: {
                dataDir,
                runtimeOwnerKind: options.runtimeOwnerKind,
                ...(options.runtimeMode ? { runtimeMode: options.runtimeMode } : {}),
            },
            nowMs,
            sinks: [
                new JsonlFileObservabilitySink({
                    dir: () => resolveV2EventDir(dataDir, runtimeNowMs()),
                    dateStamp: (epochMs) => formatV2TimestampParts(epochMs).date,
                    filePrefix: 'runtime-events',
                    nowMs,
                }),
            ],
        });
    const telemetry = composeTelemetrySinks(options.telemetry, createLocalRuntimeTelemetrySink(observability));
    const uploadsEnabled = options.diagnosticUploadsEnabled !== false;
    const metricsClient = (uploadsEnabled ? options.metricsClient : undefined) ?? buildLocalRuntimeMetricsClient(options);
    const evalReporterFactory = options.evalCapture
        ? new LocalEvalReporterFactory({ ...options.evalCapture, metricsClient })
        : undefined;
    const errorReporter = uploadsEnabled
        ? createDesktopErrorReporter({
            authContextGetter: options.authContextGetter,
            routingContextGetter: options.routingContextGetter,
            fetchImpl: options.fetchImpl,
        })
        : undefined;
    const llmRequestFailureHook = errorReporter
        ? createLLMFailureReportHook(errorReporter, {
            appVersion: options.appVersion,
        })
        : undefined;
    const bashCompletionCorrelation = new LocalBashCompletionCorrelation(metricsClient);
    // Runtime-start beacon: one bare-name counter per host boot (stored as
    // `local_runtime_started_total` — the server prepends the service name).
    metricsClient.counter('started_total', 1);
    const metricsReporter = createLocalRuntimeMetricsReporter(metricsClient);
    return {
        observability,
        telemetry,
        metricsClient,
        evalReporterFactory,
        errorReporter,
        llmRequestFailureHook,
        bashCompletionCorrelation,
        metricsReporter,
    };
}
function assertConversationUnavailable(operation) {
    throw new Error(`Local Runtime V1 Conversation is unavailable: ${operation}`);
}
//# sourceMappingURL=initialize.js.map