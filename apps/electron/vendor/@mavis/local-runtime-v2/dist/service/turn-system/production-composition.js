import { mutableTitleContext } from './agent-host/preparation/config/text-completion.js';
import { resolveSegmentContextBudget } from '@mavis/shared/segment-context-budget';
import { overridesGenericReminders, readTrustedAgentProfileCoordination, } from '@mavis/shared/agent-coordination';
import { scopeSegmentCompaction } from './agent-host/compaction/segment-turn.js';
import { createProductionRunawayGuardExtension } from './runaway-guard/extension.js';
import { streamSimple } from '@earendil-works/pi-ai';
import { outputLimitRecoveryExtension, requestMediaExtension, sessionReportExtension, toolOutputBudgetExtension, webSearchContentBudgetExtension, } from '@mavis/agent-extension';
import { withLLMRetry } from '@mavis/agent-core/pi-turn-runner';
import { describeLocalBrowserToolInput } from '@mavis/agent-tools/desktop';
import { combineAgentEventObservers } from './lifecycle/production-event-observers.js';
import { adaptCanonicalHistory } from './lifecycle/canonical-history.adapter.js';
import { createHostPtcWiring } from './lifecycle/ptc-session-store-composition.js';
import { TOOL_RESULT_COMPACTION_DEFAULTS, parseRequestMediaConfig, parseToolResultCompactionConfig, } from '@mavis/config';
import { createSideChatModeMessage, isSideChatModeMessage, ArchiveTitleModelAdapter, resolveSessionHistoryPaths, } from '../session-system/index.js';
import { isPeekSession } from '../session-system/index.js';
import { createNativeAgentHostProductionDependencies, createNativeLocalAgentPreparation, LocalAgentHost, PtcSessionStore, } from './agent-host/index.js';
import { createContextCompactors } from './compaction/execution/production-context-compactors.js';
import { createMainRequestProjection, } from './compaction/execution/request-projection.js';
import { ContextUsageAnchorState } from './compaction/execution/usage-anchor.js';
import { CheckpointImageFileWriter } from './compaction/algorithm/checkpoint-image-file-writer.js';
import { createFileApiRuntime } from './persistence/file-api-upload.repository.js';
import { createSegmentCompactionCoordinator } from './compaction/segment/composition.js';
import { ToolOutputArtifactRepository } from './persistence/tool-output-artifact.repository.js';
import { productionEmergencyFilesGrant, productionEmergencyPorts, segmentProfileSessions, } from './runtime/emergency/production.js';
import { fenceForceReleasedTurns } from './agent-host/events/released-turn-fence.js';
import { productionContextResetPort } from './runtime/emergency/context-reset.js';
import { agentHomeGrantSource, assignmentSpaceGrantSource, compactionSnapshotGrantSource, createSessionReadableGrantResolver, runtimeWorkspaceGrantSource, sessionAttachmentGrantSource, toolOutputGrantSource, } from './agent-host/runner/policy/session-readable-grants.js';
import { pluginReadGrantSources } from './agent-host/runner/policy/plugin-grant-sources.js';
import { isProductionRuntimeErrorRetryable } from './runtime-error-retry-policy.js';
import { createTodoCadenceReminderHook } from './execution/reminder/todo-cadence-reminder.js';
import { createHostTurnReminders } from './execution/reminder/host-turn-reminders.js';
import { createSessionIdentityReminderHook } from './execution/reminder/session-identity-reminder.js';
import { hasPtcTurnChildTodoWrite } from './agent-host/execution/ptc/catalog.js';
import { projectTurnRequestContext } from './agent-host/execution/ptc/compaction-reminder.js';
import { readSessionAgentExecutionSnapshot } from './agent-host/preparation/config/session-agent-execution-snapshot.js';
import { McpToolResultHistoryExternalizer } from './agent-host/execution/mcp-tool-result-history-externalizer.js';
import { createBrowserHostCapabilityAdapter } from './agent-host/assembly/host-capability/browser.js';
import { createComputerUseHostCapabilityAdapter } from './agent-host/assembly/host-capability/computer.js';
import { HostCapabilityRegistry } from './agent-host/assembly/host-capability/registry.js';
export { createGlobalMemoryModelCompletion } from '../memory-system/index.js';
export { combineAgentEventObservers, createSessionLLMRetryEventObserver, createContentReviewSlowEventObserver, } from './lifecycle/production-event-observers.js';
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
                        return library.directory(library.sessionSpace(sessionId) ?? 'default');
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
function createHostToolCatalog(options, toolOutputArtifacts, ptc) {
    return {
        // Read per Turn: the coordination owners bind their extension after the Host exists.
        coordinatorMemoryTools: (input) => options.coordinatorExtension?.()?.memoryTools?.(input) ?? [],
        hostCapabilityRegistry: createHostCapabilityRegistry(options.cliProductPolicy),
        resolveSources: async (input) => {
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
        },
        config: options.product.preparation.configBuilder.config().mcpToolSearch,
        env: process.env,
        // run_code saves a return value over 64 KiB where oversized results are externalized.
        writePtcReturnArtifact: (input) => toolOutputArtifacts.write(input),
        ...ptc,
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
/** Connects the native v2 AgentHost only to injected product, owner and observer ports. */
export async function createLocalAgentHost(options) {
    const isSideChat = (sessionId) => options.sessions.sideChats.relation(sessionId) !== undefined;
    const eventObserver = combineAgentEventObservers(options.product.eventObserver, options.eventObserver);
    const contextUsageAnchor = new ContextUsageAnchorState();
    // PTC store/load values, their temp tree, and the saved-script pieces.
    const ptc = createHostPtcWiring(options);
    // One request-only projection: installed in the main request's hook chain and repeated by
    // the shared-prefix checkpoint request, with the Turn's Tool Search context and PTC reminder.
    const mainRequest = createMainRequestProjection((sessionId, messages) => isSideChat(sessionId) ? messages : messages.filter((m) => !isSideChatModeMessage(m)), projectTurnRequestContext);
    const toolOutputArtifacts = new ToolOutputArtifactRepository({
        resolveSessionReportsDirectory: (id) => options.sessions.artifacts.ensureReportsDirectory(id),
        inspectSessionReportsDirectory: (id) => options.sessions.artifacts.inspectReportsDirectory(id),
    });
    const getToolResultCompactionConfig = createToolResultCompactionConfigGetter(options);
    const getRequestMediaConfig = createRequestMediaConfigGetter(options);
    const getImageEncoding = () => requestImageEncoding(getRequestMediaConfig().image);
    const imageFileWriter = new CheckpointImageFileWriter({
        writeImageArtifact: (input) => toolOutputArtifacts.writeImage(input),
        logger: options.product.runner.logger,
    });
    const segmentCompaction = createProductionSegmentCompaction(options, isSideChat, mainRequest);
    bindCoordinatorMemoryPrompt(options);
    const mcpToolResultHistoryExternalizer = createMcpToolResultHistoryExternalizer(options, toolOutputArtifacts, getToolResultCompactionConfig);
    const normalExtensions = createHostNormalExtensions(options, toolOutputArtifacts, getToolResultCompactionConfig, getImageEncoding);
    const dependencies = await createNativeAgentHostProductionDependencies({
        sessions: {
            get: (sessionId) => options.sessions.sessions.execution.getExecutionSnapshot(sessionId),
        },
        planDocuments: options.sessions.planDocuments,
        agents: options.product.agents,
        ...optionalPromptReadDependencies(options.product),
        turnRuntimeFacts: options.product.turnRuntimeFacts,
        preparation: options.preparation,
        toolCatalog: createHostToolCatalog(options, toolOutputArtifacts, ptc.catalog),
        inputPreparation: { ...options.product.inputPreparation, getImageEncoding },
        permission: createHostPermissionPolicy(options, toolOutputArtifacts),
        runner: {
            ...options.product.runner,
            resolveComputerUseCapture: options.resolveComputerUseCapture,
            reviewContent: options.safety.review,
            onSlowReview: options.onSlowReview,
            ...(options.reviewOfflineWait ? { reviewOfflineWait: options.reviewOfflineWait } : {}),
        },
        ...optionalToolPolicyGuard(options.toolPolicyGuard),
        executor: {
            ...options.product.executor,
            ...ptc.executor,
            nativeDelete: () => options.product.preparation.configBuilder.config().permission?.nativeDelete === true,
            logger: options.product.runner.logger,
            ...createHostTurnReminders(contextUsageAnchor, options.memorySummaryContext, options.ptcScriptCatalog, options.ptcScriptCatalogInjected),
            suppressExecutionReminders: (_session, agentConfig) => overridesGenericReminders(readTrustedAgentProfileCoordination(agentConfig.agent_profile)),
            fileApi: createFileApiRuntime({
                db: options.db,
                nowMs: options.nowMs,
                product: options.product.fileApi,
            }),
            attemptRecall: options.sessions.agentProjection.attemptRecall,
            ...(options.nowMs ? { nowMs: options.nowMs } : {}),
            cliProductPolicy: options.cliProductPolicy,
            tuiProductPolicy: options.tuiProductPolicy,
            contentReviewEnabled: options.contentReviewEnabled,
            finalizeToolResultForHistory: mcpToolResultHistoryExternalizer.finalize,
            resolvePluginHookRuntimeContext: (session) => {
                const config = options.product.preparation.configBuilder.config();
                return {
                    transcriptPath: resolveSessionHistoryPaths(config.dataDir, session).messages,
                    permissionMode: config.permissionMode,
                };
            },
            preparePluginHookSessionOwnership: options.pluginHookSessionOwnership.prepare,
            activatePluginHookSessionOwnership: options.pluginHookSessionOwnership.activate,
            afterCompactionBeforeLlmCallHooks: [...mainRequest.hooks],
            genericExecutionReminderHooks: [
                createSessionIdentityReminderHook(contextUsageAnchor),
                createTodoCadenceReminderHook(contextUsageAnchor, hasPtcTurnChildTodoWrite),
            ],
            onSteeringConsumed: options.onSteeringConsumed,
            onInputReviewResolved: options.onInputReviewResolved,
            resolveLlmRetry: options.resolveLlmRetry,
            ...optionalTurnAccounting(options.product),
            ...(options.outputTokenCap ? { outputTokenCap: options.outputTokenCap } : {}),
            turnStateLayer: () => options.coordinatorExtension?.()?.turnState,
            segmentPrefixLength: segmentCompaction.segmentPrefixLength,
            ...(options.turnFaults ? { turnFaults: options.turnFaults } : {}),
        },
        ...optionalNormalExtensions(normalExtensions),
        turnControl: options.turnControl,
        ...optionalTurnHooks(options),
        canonicalHistory: adaptCanonicalHistory(options.sessions.canonicalHistory, options.sessions.sessions.historyMutation),
        compaction: {
            ...createContextCompactors({
                // The isolated summary request drops every mode message; the replacement
                // carries a fresh one from `checkpointReminder`.
                checkpointRequestMessages: (messages) => messages.filter((message) => !isSideChatModeMessage(message)),
                mainRequestMessages: mainRequest.project,
                checkpointReminder: (sessionId, timestamp) => isSideChat(sessionId) ? createSideChatModeMessage(timestamp) : undefined,
                contextUsageAnchor,
                checkpointState: options.product.checkpointState,
                logger: options.product.runner.logger,
                imageFileWriter,
                promptSnapshots: options.product.promptSnapshots,
                readConfig: () => options.product.preparation.configBuilder.config(),
                resolveEarlierFiles: createEarlierFilesResolver(options, toolOutputArtifacts),
            }),
            control: options.turnControl,
            lifecycle: options.sessions.agentProjection.compactionLifecycle,
            barrier: options.sessions.sessions.historyMutation.compactionBarrier,
            observer: options.sessions.agentProjection.compactionObserver,
            checkpointSharedPrefixEnabled: createCheckpointSharedPrefixSwitch(options),
            ...(options.product.runner.metricsClient
                ? { metricsClient: options.product.runner.metricsClient }
                : {}),
            usageAnchor: contextUsageAnchor,
            segments: segmentCompaction.segments,
        },
        usage: {
            projector: options.sessions.usage.projector,
            onFailure: ({ sessionId, error }) => {
                options.product.executor.reportFailure?.(sessionId, `agent_usage_projection_failed:${describeError(error)}`);
            },
        },
        events: {
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
        },
        isRuntimeErrorRetryable: isProductionRuntimeErrorRetryable,
    });
    // A Turn ended by force never writes again (context reset spec 3.2).
    const host = new LocalAgentHost(fenceForceReleasedTurns(dependencies));
    return {
        host,
        // Bound by the Runtime composition so a committed context reset reaches it.
        ...(ptc.store.store ? { ptcSessionStore: ptc.store.store } : {}),
        lifecycle: ptc.store.bindLifecycle(dependencies.lifecycle),
    };
}
function createHostNormalExtensions(options, toolOutputArtifacts, getToolResultCompactionConfig, getImageEncoding) {
    return mergeNormalExtensions([
        sessionReportExtension({
            reports: options.sessions.llmCalls,
            reportFailure: options.product.executor.reportFailure,
        }),
        createHostRunawayGuardExtension(options),
        createHostOutputLimitRecoveryExtension(options),
        requestMediaExtension({ getImageEncoding }),
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
        toolOutputBudgetExtension({
            maxInlineBytes: TOOL_RESULT_COMPACTION_DEFAULTS.maxInlineKiB * 1_024,
            getMaxInlineBytes: () => getToolResultCompactionConfig().maxInlineBytes,
            fallbackPreviewBytes: 2 * 1_024,
            writeArtifact: async (input) => {
                const maxInlineBytes = getToolResultCompactionConfig().maxInlineBytes ??
                    TOOL_RESULT_COMPACTION_DEFAULTS.maxInlineKiB * 1_024;
                const artifact = await toolOutputArtifacts.write(input);
                logToolOutputBudgetDecisionBestEffort(options.product.runner.logger, {
                    input,
                    maxInlineBytes,
                    outcome: 'externalized',
                    artifactReadFormat: artifact.metadata?.read_format,
                });
                return artifact;
            },
            onArtifactError: (error, input) => logToolOutputBudgetDecisionBestEffort(options.product.runner.logger, {
                input,
                maxInlineBytes: getToolResultCompactionConfig().maxInlineBytes ??
                    TOOL_RESULT_COMPACTION_DEFAULTS.maxInlineKiB * 1_024,
                outcome: 'fallback',
                reason: safeErrorReason(error),
            }),
        }),
    ], options.product.normalExtensions, options.normalExtensions);
}
function createHostRunawayGuardExtension(options) {
    const computerUseTurns = new Set();
    const guard = createProductionRunawayGuardExtension({
        readLocalConfig: () => options.product.preparation.configBuilder.config().runawayGuard,
        readRemoteConfig: options.getRunawayGuardConfig,
        readVerifiedProgress: (input) => options.product.executor.fileChanges.takeToolProgress?.(input) ?? [],
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
function createHostOutputLimitRecoveryExtension(options) {
    const log = (outcome) => (observation) => {
        options.product.runner.logger?.[outcome === 'exhausted' ? 'error' : 'info']?.({
            event: 'output_limit_recovery',
            outcome,
            session_id: observation.sessionId,
            turn_id: observation.turnId,
            attempts: observation.attempts,
            ...(observation.truncatedToolCall === undefined
                ? {}
                : { truncated_tool_call: observation.truncatedToolCall }),
            ...(observation.model === undefined ? {} : { model: observation.model }),
        }, '[local-runtime-v2] Output limit recovery');
    };
    return outputLimitRecoveryExtension({
        onRetry: log('retry'),
        onRecovered: log('recovered'),
        onExhausted: log('exhausted'),
    });
}
function createMcpToolResultHistoryExternalizer(options, artifacts, getConfig) {
    return new McpToolResultHistoryExternalizer({
        maxInlineBytes: TOOL_RESULT_COMPACTION_DEFAULTS.mcpDetailsMaxInlineKiB * 1_024,
        getMaxInlineBytes: () => getConfig().mcpDetailsMaxInlineBytes,
        writeArtifact: (input) => artifacts.write(input),
        logger: options.product.runner.logger,
    });
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
function logToolOutputBudgetDecisionBestEffort(logger, decision) {
    try {
        const { input, maxInlineBytes, outcome, artifactReadFormat, reason } = decision;
        const fields = {
            event: 'tool_output_budget_decision',
            session_id: input.sessionId,
            turn_id: input.turnId,
            tool_name: input.toolName,
            outcome,
            original_bytes: input.originalBytes,
            max_inline_bytes: maxInlineBytes,
            ...(typeof artifactReadFormat === 'string' && artifactReadFormat.trim()
                ? { artifact_read_format: artifactReadFormat.trim() }
                : {}),
            ...(reason ? { reason } : {}),
        };
        logger?.[outcome === 'fallback' ? 'error' : 'info']?.(fields, '[local-runtime-v2] Tool output budget');
    }
    catch {
        // Diagnostics must not change the ToolResult returned to History.
    }
}
function safeErrorReason(error) {
    if (isRecord(error) && typeof error.code === 'string' && error.code.trim()) {
        return error.code.trim();
    }
    return error instanceof Error && error.name.trim() ? error.name.trim() : 'unknown_error';
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
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
function optionalPromptReadDependencies(product) {
    return {
        ...(product.promptSnapshots ? { promptSnapshots: product.promptSnapshots } : {}),
        ...(product.internalTurnPromptReads
            ? { internalTurnPromptReads: product.internalTurnPromptReads }
            : {}),
    };
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
    return merged.length > 0 ? merged : undefined;
}
function optionalTurnAccounting(product) {
    return {
        ...(product.turnRequestControl
            ? { resolveTurnRequestControl: product.turnRequestControl }
            : {}),
        ...(product.turnUsageRecorder ? { resolveTurnUsageRecorder: product.turnUsageRecorder } : {}),
    };
}
function optionalToolPolicyGuard(toolPolicyGuard) {
    return toolPolicyGuard ? { toolPolicyGuard } : {};
}
function createHostCapabilityRegistry(cliProductPolicy) {
    return new HostCapabilityRegistry([
        // CLI keeps its native Browser path; only CU uses the shared interactive Binding.
        ...(cliProductPolicy
            ? []
            : [createBrowserHostCapabilityAdapter(describeLocalBrowserToolInput)]),
        createComputerUseHostCapabilityAdapter(),
    ], { reserveInlineGateway: !cliProductPolicy });
}
function optionalNormalExtensions(normalExtensions) {
    return normalExtensions ? { normalExtensions } : {};
}
/** Optional per-Turn seams; absent ones are omitted rather than set to undefined. */
function optionalTurnHooks(options) {
    return {
        ...(options.turnTiming ? { turnTiming: options.turnTiming } : {}),
        ...(options.askUserPolicy ? { askUserPolicy: options.askUserPolicy } : {}),
        ...(options.turnCapabilities ? { turnCapabilities: options.turnCapabilities } : {}),
        ...(options.assemblyObserver ? { assemblyObserver: options.assemblyObserver } : {}),
        ...(options.promptSuggestion ? { promptSuggestion: options.promptSuggestion } : {}),
    };
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
//# sourceMappingURL=production-composition.js.map