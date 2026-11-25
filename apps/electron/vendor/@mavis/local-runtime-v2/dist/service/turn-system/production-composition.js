import { dirname } from 'node:path';
import { createSavePtcScriptTool } from '@mavis/agent-tools/desktop';
import { mutableTitleContext } from './agent-host/preparation/text-completion.js';
import { resolveSegmentContextBudget } from '@mavis/shared/segment-context-budget';
import { overridesGenericReminders, readTrustedAgentProfileCoordination, } from '@mavis/shared/agent-coordination';
import { createProductionRunawayGuardExtension } from './runaway-guard/extension.js';
import { streamSimple } from '@earendil-works/pi-ai';
import { sessionReportExtension, webSearchContentBudgetExtension } from '@mavis/agent-extension';
import { withLLMRetry } from '@mavis/agent-core/pi-turn-runner';
import { adaptCanonicalHistory } from './lifecycle/canonical-history.adapter.js';
import { createHostPtcWiring } from './lifecycle/ptc-session-store-composition.js';
import { parseRequestMediaConfig, parseToolResultCompactionConfig, } from '@mavis/config';
import { createSideChatModeMessage, isSideChatModeMessage, ArchiveTitleModelAdapter, resolveSessionHistoryPaths, } from '../session-system/index.js';
import { isPeekSession } from '../session-system/index.js';
import { createDesktopSafetyCheck, createLocalHarness, createLocalMachineCompute, createLocalRunScopes, createNativeLocalAgentPreparation, createNativePtcResultProjection, } from './agent-host/index.js';
import { combineAgentEventObservers, createAssetsUploadSyncRecorder, projectTurnRequestContext, readSessionAgentExecutionSnapshot, scopeSegmentCompaction, UNBOUNDED_HARNESS_LIMITS, } from '@mavis/harness';
import { AutomaticContextCompactor, createMainRequestProjection, } from '@mavis/harness/compaction';
import { createHostCapabilityRegistry } from './product-tools/host-capability-adapters.js';
import { desktopPromptBlocks } from './product-tools/desktop-catalog-rules.js';
import { prepareDesktopBashTools } from './product-tools/desktop-bash-tools.js';
import { createFileApiRuntime } from './persistence/file-api-upload.repository.js';
import { createSegmentCompactionCoordinator } from './compaction/segment/composition.js';
import { ToolOutputArtifactRepository } from './persistence/tool-output-artifact.repository.js';
import { isProductionRuntimeErrorRetryable } from './runtime-error-retry-policy.js';
import { packagedPtcWorkerUrl } from './runtime/ptc-worker-url.js';
import { productionEmergencyFilesGrant, productionEmergencyPorts, segmentProfileSessions, } from './runtime/emergency/production.js';
import { productionContextResetPort } from './runtime/emergency/context-reset.js';
import { agentHomeGrantSource, assignmentSpaceGrantSource, compactionSnapshotGrantSource, createSessionReadableGrantResolver, runtimeWorkspaceGrantSource, sessionAttachmentGrantSource, toolOutputGrantSource, } from './runtime/session-readable-grants.js';
import { pluginReadGrantSources } from './runtime/plugin-grant-sources.js';
import { createComputerUseCaptureStarter } from './computer-use-capture/session.js';
export { createGlobalMemoryModelCompletion } from '../memory-system/index.js';
export { createSessionLLMRetryEventObserver, createContentReviewSlowEventObserver, } from './lifecycle/production-event-observers.js';
/** Creates the one process-local AgentConfig/model preparation shared by title and AgentHost. */
export function createProductionAgentPreparation(options) {
    return createNativeLocalAgentPreparation(options);
}
/** Reuses the native Agent/model preparation and product safety checker for archived Root titles. */
export function createProductionRootArchiveTitleModel(product, nowMs) {
    const { preparation } = product;
    return new ArchiveTitleModelAdapter({
        buildAgentConfig: async (session) => {
            const agent = await readSessionAgentExecutionSnapshot(product.agents, session);
            if (!agent)
                throw new Error(`Archive title Agent not found: ${session.agentName}`);
            return preparation.buildAgentConfig({
                session,
                agent,
                isSessionFirstTurn: false,
            });
        },
        resolveModel: async (input) => {
            const resolved = await preparation.resolveModel(input);
            const resolvedStream = resolved.callLifecycle
                ? withLLMRetry(resolved.streamFn ?? streamSimple, {
                    sessionId: input.sessionId,
                    turnId: input.turnId,
                    scope: 'archive-title',
                    lifecycle: resolved.callLifecycle,
                })
                : resolved.streamFn;
            return {
                model: resolved.model,
                ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
                ...(resolved.headers ? { headers: resolved.headers } : {}),
                ...(resolved.fetch ? { fetch: resolved.fetch } : {}),
                ...(resolved.thinkingLevel ? { thinkingLevel: resolved.thinkingLevel } : {}),
                ...(resolvedStream
                    ? {
                        stream: (model, context, options) => resolvedStream(model, mutableTitleContext(context), options),
                    }
                    : {}),
                // 和本轮正文同一判断：BYOK 模型生成的归档标题不送 MiniMax 审核。
                contentReviewRequired: resolved.managedProvider === true,
            };
        },
        review: product.safety.review,
        stream: (model, context, options) => streamSimple(model, mutableTitleContext(context), options),
        ...(nowMs ? { nowMs } : {}),
    });
}
/**
 * Desktop Peek adds mutation approval; BTW shares the ordinary runtime permission policy.
 * A Mini App Agent session's ask waits only while its run has a listener to answer it.
 */
function createHostPermissionPolicy(options, toolOutputArtifacts) {
    const pluginGrants = pluginReadGrantSources(options.turnCapabilities, {
        // Read on use: a host without the repositories still composes.
        getSessionAgentDefinition: (sessionId) => options.sessions.repositories.sessions.getSessionAgentDefinition(sessionId),
    });
    return {
        ...options.product.permission,
        sideSessions: {
            isSideSession: async (sessionId) => {
                const session = await options.sessions.sessions.execution.getExecutionSnapshot(sessionId);
                return session ? session.purpose !== 'peek_btw_session' && isPeekSession(session) : false;
            },
        },
        // Paths the runtime hands the Agent inside its private data directory are
        // granted by the runtime, never derived by the permission engine. Every
        // such feature registers one source here (see session-readable-grants.ts).
        resolveSessionOwnedReadablePaths: createSessionReadableGrantResolver({
            loadSession: (sessionId) => options.sessions.sessions.execution.getExecutionSnapshot(sessionId),
            sources: [
                toolOutputGrantSource(toolOutputArtifacts),
                compactionSnapshotGrantSource({
                    inspectSnapshotsDirectory: (sessionId) => options.sessions.artifacts.inspectSnapshotsDirectory(sessionId),
                }),
                runtimeWorkspaceGrantSource({
                    dataDir: () => options.product.preparation.configBuilder.config().dataDir,
                }),
                assignmentSpaceGrantSource({
                    spaceDirectory: async (sessionId) => {
                        // Only a coordinator's task Session works in a space: zero reads for every other one.
                        if (!options.sessions.coordinatorOwnership.isAssignedTask(sessionId))
                            return undefined;
                        const session = await options.sessions.sessions.repository.get(sessionId);
                        if (!session || session.archived)
                            return undefined;
                        const library = options.sessions.artifactCatalog.library;
                        const spaceId = library.sessionSpace(sessionId);
                        return spaceId === undefined ? undefined : library.directory(spaceId);
                    },
                    spacesRoot: () => options.sessions.artifactCatalog.library.spacesRoot(),
                }),
                productionEmergencyFilesGrant(options.sessions),
                ...(options.product.sessionAssets
                    ? [sessionAttachmentGrantSource(options.product.sessionAssets)]
                    : []),
                ...(options.product.agentHomeDirectories
                    ? [agentHomeGrantSource({ homeDirectories: options.product.agentHomeDirectories })]
                    : []),
                ...pluginGrants,
            ],
            ...(options.product.permission.logger ? { logger: options.product.permission.logger } : {}),
        }),
        ...(options.miniAppApprovals ? { miniAppApprovals: options.miniAppApprovals } : {}),
    };
}
/** Turn-frozen capability views forwarded to tool sources only when present. */
function optionalTurnCapabilitySources(input) {
    return {
        ...(input.desktopCapabilities ? { desktopCapabilities: input.desktopCapabilities } : {}),
        ...(input.coordination ? { coordination: input.coordination } : {}),
    };
}
/** The segment compaction profile (spec 11) over the production ports. */
function createProductionSegmentCompaction(options, isSideChat, mainRequest) {
    const { logger, evalReporterFactory, metricsClient } = options.product.runner;
    const coordinator = createSegmentCompactionCoordinator({
        history: options.sessions.canonicalHistory,
        foregroundBudget: resolveSegmentContextBudget,
        mainRequestMessages: mainRequest.project,
        ...(options.segmentMediaDescriptions
            ? { mediaDescriptions: options.segmentMediaDescriptions }
            : {}),
        ...(options.getSegmentContextConfig ? { getConfig: options.getSegmentContextConfig } : {}),
        ...productionEmergencyPorts({
            sessions: options.sessions,
            getImageEncoding: () => requestImageEncoding(createRequestMediaConfigGetter(options)().image),
            configRepair: options.product.coordinatorConfigRepair,
            metrics: metricsClient,
        }),
        contextReset: productionContextResetPort(options.sessions, () => options.coordinatorExtension?.()?.segmentReset),
        // The coordinator's trace records it for Developer Tools and projects it to Session Clio (spec 17.1).
        reportRuntimeEvent: (sessionId, event) => {
            const trace = options.coordinatorExtension?.()?.segmentTrace;
            return trace
                ? trace.reportRuntimeEvent?.(sessionId, event)
                : evalReporterFactory?.reportRuntimeEvent?.(sessionId, event);
        },
        ...(logger ? { logger } : {}),
        // Each feature left unbound runs with an empty stand-in.
        features: () => options.coordinatorExtension?.()?.segmentFeatures,
        ...(options.nowMs ? { nowMs: options.nowMs } : {}),
    });
    const segments = scopeSegmentCompaction(coordinator, segmentProfileSessions(options.sessions, isSideChat));
    const prefixLength = (id) => segments.onProfile(id) ? coordinator.segmentPrefixLength(id) : undefined;
    return { segments, segmentPrefixLength: prefixLength };
}
/**
 * The memory block that closes the system prompt of an Agent with a coordination memory pipeline,
 * read per Turn from the coordinator extension. A Host composed without that capability keeps the
 * preparation's own provider.
 */
function bindCoordinatorMemoryPrompt(options) {
    const extension = options.coordinatorExtension;
    if (!extension)
        return;
    options.preparation.bindCoordinatorMemoryProvider((context) => extension()?.memoryPrompt?.(context) ?? Promise.resolve(''));
}
/**
 * Connects the native v2 Harness only to injected product, owner and observer
 * ports. The kernel is assembled inside the Harness; this root supplies policy
 * and the Session-side ports.
 */
export async function createLocalAgentHost(options) {
    const isSideChat = (sessionId) => options.sessions.sideChats.relation(sessionId) !== undefined;
    const requestMessages = createRequestMessageFilter(isSideChat);
    // PTC store/load values, their temp tree, and the saved-script pieces.
    const ptc = createHostPtcWiring(options);
    // The segment coordinator repeats the main request's request-only steps, with the Turn's
    // Tool Search context and PTC reminder, for its shared-prefix checkpoint request.
    const mainRequest = createMainRequestProjection(requestMessages, projectTurnRequestContext);
    const toolOutputArtifacts = new ToolOutputArtifactRepository({
        resolveSessionReportsDirectory: (id) => options.sessions.artifacts.ensureReportsDirectory(id),
        inspectSessionReportsDirectory: (id) => options.sessions.artifacts.inspectReportsDirectory(id),
    });
    const getToolResultCompactionConfig = createToolResultCompactionConfigGetter(options);
    const getRequestMediaConfig = createRequestMediaConfigGetter(options);
    const getImageEncoding = () => requestImageEncoding(getRequestMediaConfig().image);
    const { contextUsage, ...runnerSinks } = options.product.runner;
    const segmentCompaction = createProductionSegmentCompaction(options, isSideChat, mainRequest);
    bindCoordinatorMemoryPrompt(options);
    const dependencies = {
        policy: createHostProductPolicy(options, getImageEncoding),
        extensions: (runs) => createHostNormalExtensions(options, runs, toolOutputArtifacts),
        compaction: {
            compactionTriggerAt: () => options.product.preparation.configBuilder.config().contextManagement?.compactionTriggerAt,
            toolResults: getToolResultCompactionConfig,
            checkpointRequestMessages: (messages) => messages.filter((message) => !isSideChatModeMessage(message)),
            checkpointSharedPrefixEnabled: createCheckpointSharedPrefixSwitch(options),
        },
        pools: {
            disposeSession: async (sessionId) => {
                await options.product.permission.mutations?.clearSession(sessionId);
            },
        },
        limits: UNBOUNDED_HARNESS_LIMITS,
        observability: {
            ...runnerSinks,
            beginComputerUseCapture: createComputerUseCaptureStarter(options.resolveComputerUseCapture, runnerSinks.logger),
        },
        toolResultHistoryFinalizer: (base) => withAssetsUploadSyncRecorder(options, base),
        isRuntimeErrorRetryable: isProductionRuntimeErrorRetryable,
        promptSuggestion: options.promptSuggestion,
        onReplyCommitted: options.product.executor.onReplyCommitted,
        pluginHooks: options.pluginHooks,
        ptc: {
            workerUrl: packagedPtcWorkerUrl(),
            unavailableMessage: 'run_code is available only during an active Desktop turn.',
            // `ptc.catalog` is empty when both beta switches are off, and each field
            // is dropped on its own, so the harness sees no store and no script host
            // unless this Host really wired one. `ptc.executor` is not passed: the
            // harness derives the executor's store and `ptcScriptsEnabled` from these
            // two, so the two views of the same wiring can never disagree.
            ...(ptc.catalog.ptcSessionStore ? { sessionStore: ptc.catalog.ptcSessionStore } : {}),
            ...(ptc.catalog.ptcScripts
                ? {
                    scripts: {
                        ...ptc.catalog.ptcScripts,
                        // The save tool writes files and the save boundary is path
                        // arithmetic; both belong to this Host, so the harness reaches
                        // them through its script port instead of agent-tools' desktop
                        // entry, which carries that Node IO.
                        createSaveTool: createSavePtcScriptTool,
                        containingDirectory: (directory) => dirname(directory),
                    },
                }
                : {}),
            ...(options.ptcScriptCatalog ? { scriptCatalog: options.ptcScriptCatalog } : {}),
            ...(options.ptcScriptCatalogInjected
                ? { scriptCatalogInjected: options.ptcScriptCatalogInjected }
                : {}),
        },
        // TurnController.close has already aborted and drained (bounded) every run and compaction.
        closeDrainTimeoutMs: 0,
    };
    const scope = {
        agent: {
            source: options.product.agents,
            preparation: options.preparation,
            promptSnapshots: options.product.promptSnapshots,
            internalTurnPromptReads: options.product.internalTurnPromptReads,
            turnRuntimeFacts: options.product.turnRuntimeFacts,
        },
        host: createHostBinding(options, toolOutputArtifacts, contextUsage, createHostCompactionBinding(options, isSideChat, requestMessages, segmentCompaction)),
        model: { credential: (model) => options.preparation.credential(model) },
        artifacts: {
            write: (input) => toolOutputArtifacts.write(input),
            writeImage: (input) => toolOutputArtifacts.writeImage(input),
            resolveEarlierFiles: createEarlierFilesResolver(options, toolOutputArtifacts),
        },
        turnDiff: options.product.executor.fileChanges,
        compute: createLocalMachineCompute({
            dataDir: () => options.product.preparation.configBuilder.config().dataDir,
        }),
        telemetry: {
            usage: {
                projector: options.sessions.usage.projector,
                onFailure: ({ sessionId, error }) => {
                    options.product.executor.reportFailure?.(sessionId, `agent_usage_projection_failed:${describeError(error)}`);
                },
            },
            assemblyObserver: options.assemblyObserver,
            turnTiming: options.turnTiming,
        },
    };
    const composition = createLocalHarness(dependencies, withForceReleaseProbe(createLocalRunScopes(scope, options.turnControl), options.turnControl));
    return {
        ...composition,
        // Bound by the Runtime composition so a committed context reset reaches it.
        ...(ptc.store.store ? { ptcSessionStore: ptc.store.store } : {}),
        lifecycle: ptc.store.bindLifecycle(composition.lifecycle),
    };
}
function createHostProductPolicy(options, getImageEncoding) {
    const config = () => options.product.preparation.configBuilder.config();
    return {
        cliProductPolicy: options.cliProductPolicy,
        tuiProductPolicy: options.tuiProductPolicy,
        ptcSurface: options.product.executor.ptcSurface,
        // Desktop bounds a run_code child's display copy the same way Cloud does.
        // Without it a single child keeps its whole result in the display copy,
        // history and the UI, which is what the preview exists to prevent.
        ptcChildDisplayPreview: true,
        // Default SafetyPolicy: the desktop reviews input, output and thinking only.
        safety: { host: 'desktop' },
        nativeDelete: () => config().permission?.nativeDelete === true,
        createTurnToolSafetyGuard: options.product.executor.createTurnToolSafetyGuard,
        toolPolicyGuard: options.toolPolicyGuard,
        nowMs: options.nowMs,
        getImageEncoding,
        askUserPolicy: options.askUserPolicy,
        suppressExecutionReminders: (_session, agentConfig) => overridesGenericReminders(readTrustedAgentProfileCoordination(agentConfig.agent_profile)),
        toolCatalog: {
            config: config().mcpToolSearch,
            env: process.env,
            // The Runtime's one receipt store: the catalog gate, the first-Turn
            // preload and the committed-compaction clear all read this instance, and
            // the Application layer's rewind / session-deleted clears share it.
            skillReceipts: options.skillReceipts,
        },
    };
}
/** Session-side ports shared by every run; Turn control is added per accepted lease. */
function createHostBinding(options, toolOutputArtifacts, contextUsage, compaction) {
    return {
        events: createHostEventPorts(options),
        history: adaptCanonicalHistory(options.sessions.canonicalHistory, options.sessions.sessions.historyMutation),
        session: {
            get: (sessionId) => options.sessions.sessions.execution.getExecutionSnapshot(sessionId),
            planDocuments: options.sessions.planDocuments,
        },
        compaction,
        permissions: createHostPermissionPolicy(options, toolOutputArtifacts),
        input: options.product.inputPreparation,
        tools: {
            contribute: async (input) => ({
                tools: await resolveHostToolSources(options, input),
                promptBlocks: desktopPromptBlocks,
            }),
            capabilities: createHostCapabilityRegistry(options.cliProductPolicy),
            createChildBashLifecycle: options.product.executor.createChildBashLifecycle,
            prepareBashTools: prepareDesktopBashTools,
            createPtcResultProjection: createNativePtcResultProjection,
            // Read per Turn: the coordination owners bind their extension after the Host exists.
            coordinatorMemoryTools: (input) => options.coordinatorExtension?.()?.memoryTools?.(input) ?? [],
        },
        // 本地送审端口一直给；服务端审核开关开着的轮次，runner 转去网关模式，由模型网关审核。
        safety: {
            reviewContent: options.safety.review,
            check: createDesktopSafetyCheck(options.safety.review),
            onSlowReview: options.onSlowReview,
            ...(options.reviewOfflineWait ? { reviewOfflineWait: options.reviewOfflineWait } : {}),
            ...(options.gatewayReviewEnabled
                ? { gatewayReviewEnabled: options.gatewayReviewEnabled }
                : {}),
            onInputReviewResolved: options.onInputReviewResolved,
        },
        projection: {
            attemptRecall: options.sessions.agentProjection.attemptRecall,
            onSteeringConsumed: options.onSteeringConsumed,
            reportFailure: options.product.executor.reportFailure,
            projectRuntimeEvent: options.product.executor.projectRuntimeEvent,
            contextUsage,
        },
        accounting: {
            outputTokenCap: options.outputTokenCap,
            resolveLlmRetry: options.resolveLlmRetry,
            resolveTurnRequestControl: options.product.turnRequestControl,
            resolveTurnUsageRecorder: options.product.turnUsageRecorder,
        },
        fileApi: createFileApiRuntime({
            db: options.db,
            nowMs: options.nowMs,
            product: options.product.fileApi,
        }),
        hooks: createHostPluginHooks(options),
        backgroundTasks: {
            confirm: async (input) => await options.product.inputPreparation.reminders.confirmBackgroundTaskReads(input),
        },
        ...(options.memorySummaryContext ? { memorySummary: options.memorySummaryContext } : {}),
        turnState: () => options.coordinatorExtension?.()?.turnState,
        ...(options.turnFaults ? { turnFaults: options.turnFaults } : {}),
    };
}
/**
 * Records every `space_upload` ToolResult beside the harness History finalizer, so the Working
 * folder can show its cloud sync state. The recorder only reads the ToolResult and never changes
 * it; the harness finalizer still decides what reaches History.
 */
function withAssetsUploadSyncRecorder(options, base) {
    const record = createAssetsUploadSyncRecorder({
        record: (input) => options.sessions.files.recordSessionFileSync(input),
        logger: options.product.runner.logger,
    });
    return async (input, signal) => {
        await record(input, signal);
        return base(input, signal);
    };
}
/**
 * `createLocalRunScopes` lifts only the lease-scoped callbacks. The force-release probe is
 * lease-independent, so it is re-attached here for the run fence that drops every late write of
 * a Turn ended by force (context reset spec 3.2).
 */
function withForceReleaseProbe(scopes, turnControl) {
    const isForceReleased = turnControl.isForceReleased?.bind(turnControl);
    if (!isForceReleased)
        return scopes;
    return {
        compaction: scopes.compaction,
        run: (lease, beforeCapabilityCapture) => {
            const run = scopes.run(lease, beforeCapabilityCapture);
            return {
                ...run,
                host: { ...run.host, control: { ...run.host.control, isForceReleased } },
            };
        },
    };
}
function createHostEventPorts(options) {
    const eventObserver = combineAgentEventObservers(options.product.eventObserver, options.eventObserver);
    return {
        projectors: {
            session: options.sessions.agentProjection.session,
            messages: withContextUsageProjection(options.sessions.agentProjection.messages, options.contextUsageProjection),
            stream: options.sessions.agentProjection.stream,
            turnFacts: options.turnFacts,
        },
        historyFailures: options.sessions.agentProjection.historyFailures,
        ...(eventObserver ? { observer: eventObserver } : {}),
        onObservationFailure: ({ sessionId, error }) => {
            options.product.executor.reportFailure?.(sessionId, `agent_event_observation_failed:${describeError(error)}`);
        },
    };
}
/** A side chat keeps its mode messages; every other Session drops them from Provider requests. */
function createRequestMessageFilter(isSideChat) {
    return (sessionId, messages) => isSideChat(sessionId)
        ? messages
        : messages.filter((message) => !isSideChatModeMessage(message));
}
function createHostCompactionBinding(options, isSideChat, requestMessages, segmentCompaction) {
    return {
        control: options.turnControl,
        lifecycle: options.sessions.agentProjection.compactionLifecycle,
        barrier: options.sessions.sessions.historyMutation.compactionBarrier,
        observer: options.sessions.agentProjection.compactionObserver,
        checkpointState: options.product.checkpointState,
        checkpointReminder: (sessionId, timestamp) => isSideChat(sessionId) ? createSideChatModeMessage(timestamp) : undefined,
        requestMessages,
        segments: segmentCompaction.segments,
        segmentPrefixLength: segmentCompaction.segmentPrefixLength,
    };
}
function createHostPluginHooks(options) {
    return {
        capabilities: options.turnCapabilities,
        resolveRuntimeContext: (session) => {
            const config = options.product.preparation.configBuilder.config();
            return {
                transcriptPath: resolveSessionHistoryPaths(config.dataDir, session).messages,
                permissionMode: config.permissionMode,
            };
        },
        prepareSessionOwnership: options.pluginHookSessionOwnership.prepare,
        activateSessionOwnership: options.pluginHookSessionOwnership.activate,
    };
}
async function resolveHostToolSources(options, input) {
    const session = await requireExecutionSession(options.sessions, input);
    return options.product.toolSources.resolve({
        session,
        turnId: input.turnId,
        resourceAgentName: input.resourceAgentName,
        ...(input.excludeAgentResources ? { excludeAgentResources: true } : {}),
        ...(input.skipAgentResolution ? { skipAgentResolution: true } : {}),
        ...(input.expectedAgentInstanceId
            ? { expectedAgentInstanceId: input.expectedAgentInstanceId }
            : {}),
        ...(input.builtinCapabilities ? { builtinCapabilities: input.builtinCapabilities } : {}),
        toolsDisabled: process.env.MAVIS_LOCAL_RUNTIME_DISABLE_TOOLS === '1',
        computerUseActive: input.computerUseActive,
        ...(input.agentMemoryEnabled === undefined
            ? {}
            : { agentMemoryEnabled: input.agentMemoryEnabled }),
        ...(input.agentMemoryReadNames === undefined
            ? {}
            : { agentMemoryReadNames: input.agentMemoryReadNames }),
        ...optionalTurnCapabilitySources(input),
    });
}
/**
 * Host builtins; Turn progress comes from the scope of the run owning the Turn. The harness
 * appends output-limit recovery, request media and the tool-output budget after these.
 */
function createHostNormalExtensions(options, runs, toolOutputArtifacts) {
    return mergeNormalExtensions([
        sessionReportExtension({
            reports: options.sessions.llmCalls,
            reportFailure: options.product.executor.reportFailure,
        }),
        createHostRunawayGuardExtension(options, runs),
        // Before the output budget: each page is bounded first, so the whole result rarely needs a receipt.
        webSearchContentBudgetExtension({
            writeArtifact: (input) => toolOutputArtifacts.write(input),
            // The extension swallows observer errors, so a throwing logger cannot change the result.
            onArtifactError: (error, input) => options.product.runner.logger?.error?.({
                event: 'web_search_content_budget_failed',
                session_id: input.sessionId,
                turn_id: input.turnId,
                reason: safeErrorReason(error),
            }, '[local-runtime-v2] web_search content kept whole: artifact write failed'),
        }),
    ], options.product.normalExtensions, options.normalExtensions);
}
function createHostRunawayGuardExtension(options, runs) {
    const computerUseTurns = new Set();
    const guard = createProductionRunawayGuardExtension({
        readLocalConfig: () => options.product.preparation.configBuilder.config().runawayGuard,
        readRemoteConfig: options.getRunawayGuardConfig,
        readVerifiedProgress: (input) => runs.scope(input)?.turnDiff.takeToolProgress?.(input) ?? [],
        logger: options.product.runner.logger,
        reportEvent: (sessionId, event) => {
            if (computerUseTurns.has(JSON.stringify([sessionId, event.payload.turn_id])))
                return;
            options.product.runner.evalReporterFactory?.reportRuntimeEvent?.(sessionId, event);
        },
    });
    return {
        ...guard,
        async init(api) {
            api.on('turn_start', (_event, ctx) => {
                if (hasComputerUseHistory(ctx.history))
                    computerUseTurns.add(computerUseTurnKey(ctx));
            });
            api.on('before_llm_call', (event, ctx) => {
                if (event.tools?.some((tool) => tool.name.startsWith('computer_')) ||
                    hasComputerUseHistory(event.messages) ||
                    hasComputerUseHistory(ctx.history)) {
                    computerUseTurns.add(computerUseTurnKey(ctx));
                }
            });
            api.on('before_tool_call', (event, _signal, ctx) => {
                if (event.toolCall.name.startsWith('computer_')) {
                    computerUseTurns.add(computerUseTurnKey(ctx));
                }
                return undefined;
            });
            await guard.init(api);
            // Registered after the guard: its turn_end summary must remain isolated too.
            api.on('turn_end', (_event, ctx) => {
                computerUseTurns.delete(computerUseTurnKey(ctx));
            });
        },
    };
}
function computerUseTurnKey(ctx) {
    return JSON.stringify([ctx.sessionId, ctx.turnId]);
}
function hasComputerUseHistory(messages) {
    return messages.some((message) => (message.role === 'toolResult' && message.toolName.startsWith('computer_')) ||
        (message.role === 'assistant' &&
            message.content.some((part) => part.type === 'toolCall' && part.name.startsWith('computer_'))));
}
function createEarlierFilesResolver(options, toolOutputArtifacts) {
    return async (sessionId) => {
        const [snapshots, toolOutputs] = await Promise.all([
            options.sessions.artifacts.resolveSnapshotsDirectory(sessionId),
            toolOutputArtifacts.directory(sessionId),
        ]);
        return { snapshots, toolOutputs };
    };
}
function createRequestMediaConfigGetter(options) {
    return () => {
        let raw;
        try {
            raw = options.product.preparation.configBuilder.config().requestMedia;
        }
        catch {
            raw = undefined;
        }
        return parseRequestMediaConfig(raw);
    };
}
function requestImageEncoding(image) {
    return {
        maxWidth: image.max_width,
        maxHeight: image.max_height,
        maxBase64Bytes: image.max_base64_bytes,
    };
}
/** Remote kill switch: only an explicit Apollo `false` restores the isolated checkpoint request. */
function createCheckpointSharedPrefixSwitch(options) {
    return () => readToolResultCompactionOverride(options.getToolResultCompactionConfig)
        ?.checkpointSharedPrefix !== false;
}
function createToolResultCompactionConfigGetter(options) {
    const fileConfig = parseToolResultCompactionConfig(readToolResultCompactionFileConfig(options));
    const base = {
        maxInlineBytes: fileConfig.maxInlineKiB * 1_024,
        mcpDetailsMaxInlineBytes: fileConfig.mcpDetailsMaxInlineKiB * 1_024,
    };
    return () => {
        const override = readToolResultCompactionOverride(options.getToolResultCompactionConfig);
        return {
            maxInlineBytes: positiveSafeInteger(override?.maxInlineBytes) ?? base.maxInlineBytes,
            mcpDetailsMaxInlineBytes: positiveSafeInteger(override?.mcpDetailsMaxInlineBytes) ?? base.mcpDetailsMaxInlineBytes,
        };
    };
}
function readToolResultCompactionFileConfig(options) {
    try {
        return options.product.preparation.configBuilder.config().toolResultCompaction;
    }
    catch {
        return undefined;
    }
}
function readToolResultCompactionOverride(getter) {
    try {
        return getter?.();
    }
    catch {
        return undefined;
    }
}
function positiveSafeInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function withContextUsageProjection(messages, contextUsage) {
    if (!contextUsage)
        return messages;
    return {
        async projectRuntimeEvent(input) {
            const result = await messages.projectRuntimeEvent(input);
            await contextUsage.projectRuntimeEvent(input);
            return result;
        },
        projectHistoryCommitted: (input) => messages.projectHistoryCommitted(input),
    };
}
function mergeNormalExtensions(builtins, product, additional) {
    const configured = [...(product ?? []), ...(additional ?? [])];
    const builtinIds = new Set(builtins.map((extension) => extension.id));
    const merged = [
        ...configured.filter((extension) => !builtinIds.has(extension.id)),
        // Host-owned builtins establish terminal postconditions. They must observe every configured
        // after_tool_call rewrite and cannot be replaced by a configured extension with the same id.
        ...builtins,
    ];
    return merged;
}
async function requireExecutionSession(sessions, input) {
    const session = await sessions.sessions.repository.get(input.sessionId);
    if (!session ||
        session.agentName !== input.agentName ||
        session.workspaceDir !== input.workspaceDir) {
        throw new Error(`AgentHost tool source Session mismatch: ${input.sessionId}`);
    }
    return session;
}
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
function safeErrorReason(error) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
        const code = error.code;
        if (typeof code === 'string' && code.trim())
            return code.trim();
    }
    return error instanceof Error && error.name.trim() ? error.name.trim() : 'unknown_error';
}
/**
 * 记忆整理 Agent 的上下文压缩：与普通会话共用同一套压缩算法，reminder 是压缩后补回的接续消息。
 * 整理不属于任何 Session，sessionId 只是固定标识。
 */
export const createMemoryContextCompactor = (reminder) => {
    const compactor = new AutomaticContextCompactor(undefined, undefined, undefined, {
        checkpointReminder: reminder,
    });
    return async (input) => {
        const result = await compactor.compactBeforeLlm({
            ...input,
            tools: [...input.tools],
            messages: [...input.messages],
            sessionId: 'memory-v2:consolidation',
            phase: 'iteration',
        });
        return result.status === 'unchanged'
            ? undefined
            : result.replacementMessages;
    };
};
//# sourceMappingURL=production-composition.js.map