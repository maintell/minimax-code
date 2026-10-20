import { createProductionRunawayGuardExtension } from './runaway-guard/extension.js';
import { streamSimple } from '@earendil-works/pi-ai';
import { outputLimitRecoveryExtension, requestMediaExtension, sessionReportExtension, toolOutputBudgetExtension, } from '@mavis/agent-extension';
import { describeLocalBrowserToolInput } from '@mavis/agent-tools/desktop';
import { TOOL_RESULT_COMPACTION_DEFAULTS, parseRequestMediaConfig, parseToolResultCompactionConfig, } from '@mavis/config';
import { createSideChatModeMessage, isSideChatModeMessage, ArchiveTitleModelAdapter, SessionTitleModelAdapter, resolveSessionHistoryPaths, } from '../session-system/index.js';
import { isPeekSession } from '../session-system/sessions/repo/normalization.js';
import { createNativeAgentHostProductionDependencies, createNativeLocalAgentPreparation, LocalAgentHost, } from './agent-host/index.js';
import { validateCanonicalHistoryMessages } from './agent-host/history/canonical-history-validation.js';
import { readCompactionCommitMetadata } from './agent-host/compaction/context-compaction.js';
import { LocalContextCompactor } from './compaction/local-context-compactor.js';
import { AutomaticContextCompactor, createAutomaticContextRequestFilterHook, createRequestMediaGuardHook, } from './compaction/automatic-context-compactor.js';
import { ContextUsageAnchorState } from './compaction/execution/usage-anchor.js';
import { ToolResultArchiver } from './compaction/algorithm/tool-result-archiver.js';
import { createFileApiUploadStoreSource } from './persistence/file-api-upload.repository.js';
import { ToolOutputArtifactRepository } from './persistence/tool-output-artifact.repository.js';
import { isProductionRuntimeErrorRetryable } from './runtime-error-retry-policy.js';
import { createTodoCadenceReminderHook } from './execution/reminder/todo-cadence-reminder.js';
import { createBackgroundCadenceReminder } from './execution/reminder/background-cadence-reminder.js';
import { createSessionIdentityReminderHook } from './execution/reminder/session-identity-reminder.js';
import { fitsReminderInFinalRequest } from './execution/reminder/reminder-admission.js';
import { readSessionAgentExecutionSnapshot } from './agent-host/preparation/session-agent-execution-snapshot.js';
import { McpToolResultHistoryExternalizer } from './agent-host/execution/mcp-tool-result-history-externalizer.js';
import { createBrowserHostCapabilityAdapter } from './agent-host/assembly/host-capability/browser.js';
import { createComputerUseHostCapabilityAdapter } from './agent-host/assembly/host-capability/computer.js';
import { HostCapabilityRegistry } from './agent-host/assembly/host-capability/registry.js';
export { createGlobalMemoryModelCompletion } from './memory-model/completion.js';
/** Creates the one process-local AgentConfig/model preparation shared by title and AgentHost. */
export function createProductionAgentPreparation(options) {
    return createNativeLocalAgentPreparation(options);
}
/** Uses the same product Agent/config/model resolution as normal native AgentHost turns. */
export function createProductionSessionTitleModel(product, nowMs) {
    const { preparation } = product;
    return new SessionTitleModelAdapter({
        buildAgentConfig: async (session) => {
            const agent = await readSessionAgentExecutionSnapshot(product.agents, session);
            if (!agent)
                throw new Error(`Session title Agent not found: ${session.agentName}`);
            return preparation.buildAgentConfig({
                session,
                agent,
                isSessionFirstTurn: true,
            });
        },
        resolveModel: async (input) => {
            const resolved = await preparation.resolveModel(input);
            const resolvedStream = resolved.streamFn;
            return {
                model: resolved.model,
                ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
                ...(resolved.headers ? { headers: resolved.headers } : {}),
                ...(resolved.thinkingLevel ? { thinkingLevel: resolved.thinkingLevel } : {}),
                ...(resolvedStream
                    ? {
                        stream: (model, context, options) => resolvedStream(model, mutableTitleContext(context), options),
                    }
                    : {}),
            };
        },
        stream: (model, context, options) => streamSimple(model, mutableTitleContext(context), options),
        ...(nowMs ? { nowMs } : {}),
    });
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
            const resolvedStream = resolved.streamFn;
            return {
                model: resolved.model,
                ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
                ...(resolved.headers ? { headers: resolved.headers } : {}),
                ...(resolved.thinkingLevel ? { thinkingLevel: resolved.thinkingLevel } : {}),
                ...(resolvedStream
                    ? {
                        stream: (model, context, options) => resolvedStream(model, mutableTitleContext(context), options),
                    }
                    : {}),
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
function createHostPermissionPolicy(options) {
    return {
        ...options.product.permission,
        sideSessions: {
            isSideSession: async (sessionId) => {
                const session = await options.sessions.sessions.execution.getExecutionSnapshot(sessionId);
                return session ? session.purpose !== 'peek_btw_session' && isPeekSession(session) : false;
            },
        },
        ...(options.miniAppApprovals ? { miniAppApprovals: options.miniAppApprovals } : {}),
    };
}
/** Connects the native v2 AgentHost only to injected product, owner and observer ports. */
export async function createLocalAgentHost(options) {
    const isSideChat = (sessionId) => options.sessions.sideChats.relation(sessionId) !== undefined;
    const eventObserver = combineAgentEventObservers(options.product.eventObserver, options.eventObserver);
    const contextUsageAnchor = new ContextUsageAnchorState();
    const toolOutputArtifacts = createToolOutputArtifactRepository(options);
    const getToolResultCompactionConfig = createToolResultCompactionConfigGetter(options);
    const getRequestMediaConfig = createRequestMediaConfigGetter(options);
    const getRecoveryDivisor = () => getRequestMediaConfig().recoveryDivisor;
    const getImageEncoding = () => requestImageEncoding(getRequestMediaConfig().image);
    const toolResultArchiver = new ToolResultArchiver({
        writeArtifact: (input) => toolOutputArtifacts.write(input),
        writeImageArtifact: (input) => toolOutputArtifacts.writeImage(input),
        logger: options.product.runner.logger,
        getConfig: getToolResultCompactionConfig,
    });
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
        toolCatalog: {
            ...optionalDesktopHostCapabilities(options.cliProductPolicy),
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
                    ...(input.allowedSkillNames === undefined
                        ? {}
                        : { allowedSkillNames: input.allowedSkillNames }),
                    ...(input.allowedExtensionSkillNames === undefined
                        ? {}
                        : { allowedExtensionSkillNames: input.allowedExtensionSkillNames }),
                    ...(input.desktopCapabilities ? { desktopCapabilities: input.desktopCapabilities } : {}),
                });
            },
            config: options.product.preparation.configBuilder.config().mcpToolSearch,
            env: process.env,
        },
        inputPreparation: { ...options.product.inputPreparation, getImageEncoding },
        permission: createHostPermissionPolicy(options),
        runner: {
            ...options.product.runner,
            reviewContent: options.safety.review,
        },
        ...optionalToolPolicyGuard(options.toolPolicyGuard),
        executor: {
            ...options.product.executor,
            nativeDelete: () => options.product.preparation.configBuilder.config().permission?.nativeDelete === true,
            logger: options.product.runner.logger,
            backgroundCadenceReminder: createBackgroundCadenceReminder(contextUsageAnchor),
            canAppendExecutionBudgetReminder: (input, marker) => fitsReminderInFinalRequest(input, marker, contextUsageAnchor),
            fileApi: {
                uploadStores: createFileApiUploadStoreSource({
                    db: options.db,
                    ...(options.nowMs ? { nowMs: options.nowMs } : {}),
                }),
                ...(options.product.fileApi?.fetchImpl
                    ? { fetchImpl: options.product.fileApi.fetchImpl }
                    : {}),
                ...(options.product.fileApi?.logger ? { logger: options.product.fileApi.logger } : {}),
            },
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
            afterCompactionBeforeLlmCallHooks: [
                createAutomaticContextRequestFilterHook((sessionId, messages) => isSideChat(sessionId)
                    ? messages
                    : messages.filter((message) => !isSideChatModeMessage(message))),
                createRequestMediaGuardHook(getRecoveryDivisor),
                createSessionIdentityReminderHook(contextUsageAnchor),
                createTodoCadenceReminderHook(contextUsageAnchor),
            ],
            onSteeringConsumed: options.onSteeringConsumed,
            onInputReviewResolved: options.onInputReviewResolved,
            resolveLlmRetry: options.resolveLlmRetry,
            ...(options.outputTokenCap ? { outputTokenCap: options.outputTokenCap } : {}),
        },
        ...optionalNormalExtensions(normalExtensions),
        turnControl: options.turnControl,
        ...(options.turnCapabilities ? { turnCapabilities: options.turnCapabilities } : {}),
        ...(options.assemblyObserver ? { assemblyObserver: options.assemblyObserver } : {}),
        canonicalHistory: adaptCanonicalHistory(options.sessions.canonicalHistory, options.sessions.sessions.historyMutation),
        compaction: {
            ...createContextCompactors({
                checkpointRequestMessages: (messages) => messages.filter((message) => !isSideChatModeMessage(message)),
                checkpointReminder: (sessionId, timestamp) => isSideChat(sessionId) ? createSideChatModeMessage(timestamp) : undefined,
                contextUsageAnchor,
                checkpointState: options.product.checkpointState,
                logger: options.product.runner.logger,
                toolResultArchiver,
                promptSnapshots: options.product.promptSnapshots,
                getRecoveryDivisor,
                resolveEarlierFiles: async (sessionId) => {
                    const [snapshots, toolOutputs] = await Promise.all([
                        options.sessions.artifacts.resolveSnapshotsDirectory(sessionId),
                        toolOutputArtifacts.directory(sessionId),
                    ]);
                    return { snapshots, toolOutputs };
                },
            }),
            control: options.turnControl,
            lifecycle: options.sessions.agentProjection.compactionLifecycle,
            barrier: options.sessions.sessions.historyMutation.compactionBarrier,
            observer: options.sessions.agentProjection.compactionObserver,
            ...(options.product.runner.metricsClient
                ? { metricsClient: options.product.runner.metricsClient }
                : {}),
            usageAnchor: contextUsageAnchor,
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
    return { host: new LocalAgentHost(dependencies), lifecycle: dependencies.lifecycle };
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
    return createProductionRunawayGuardExtension({
        readLocalConfig: () => options.product.preparation.configBuilder.config().runawayGuard,
        readRemoteConfig: options.getRunawayGuardConfig,
        readVerifiedProgress: (input) => options.product.executor.fileChanges.takeToolProgress?.(input) ?? [],
        logger: options.product.runner.logger,
        reportEvent: (sessionId, event) => options.product.runner.evalReporterFactory?.reportRuntimeEvent?.(sessionId, event),
    });
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
function createToolOutputArtifactRepository(options) {
    return new ToolOutputArtifactRepository({
        resolveSessionReportsDirectory: (sessionId) => options.sessions.artifacts.ensureReportsDirectory(sessionId),
    });
}
function createContextCompactors(input) {
    return {
        automatic: new AutomaticContextCompactor(input.contextUsageAnchor, input.checkpointState, input.logger, {
            checkpointRequestMessages: input.checkpointRequestMessages,
            checkpointReminder: input.checkpointReminder,
            toolResultArchiver: input.toolResultArchiver,
            promptSnapshots: input.promptSnapshots,
            getRecoveryDivisor: input.getRecoveryDivisor,
            resolveEarlierFiles: input.resolveEarlierFiles,
        }),
        manual: new LocalContextCompactor(input.checkpointState, input.logger, input.promptSnapshots, {
            imageFileWriter: input.toolResultArchiver,
            resolveEarlierFiles: input.resolveEarlierFiles,
            reminder: input.checkpointReminder,
            projectRequestMessages: input.checkpointRequestMessages,
        }),
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
function createToolResultCompactionConfigGetter(options) {
    const fileConfig = parseToolResultCompactionConfig(readToolResultCompactionFileConfig(options));
    const base = {
        enabled: fileConfig.enabled,
        maxInlineBytes: fileConfig.maxInlineKiB * 1_024,
        mcpDetailsMaxInlineBytes: fileConfig.mcpDetailsMaxInlineKiB * 1_024,
        watermarkBytes: fileConfig.watermarkKiB * 1_024,
        minSavingsBytes: fileConfig.minSavingsKiB * 1_024,
        minCandidateBytes: fileConfig.minCandidateKiB * 1_024,
        keepRecentRounds: fileConfig.keepRecentRounds,
    };
    return () => {
        const override = readToolResultCompactionOverride(options.getToolResultCompactionConfig);
        return {
            enabled: typeof override?.enabled === 'boolean' ? override.enabled : base.enabled,
            maxInlineBytes: positiveSafeInteger(override?.maxInlineBytes) ?? base.maxInlineBytes,
            mcpDetailsMaxInlineBytes: positiveSafeInteger(override?.mcpDetailsMaxInlineBytes) ?? base.mcpDetailsMaxInlineBytes,
            watermarkBytes: positiveSafeInteger(override?.watermarkBytes) ?? base.watermarkBytes,
            minSavingsBytes: positiveSafeInteger(override?.minSavingsBytes) ?? base.minSavingsBytes,
            minCandidateBytes: positiveSafeInteger(override?.minCandidateBytes) ?? base.minCandidateBytes,
            keepRecentRounds: positiveSafeInteger(override?.keepRecentRounds) ?? base.keepRecentRounds,
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
function optionalToolPolicyGuard(toolPolicyGuard) {
    return toolPolicyGuard ? { toolPolicyGuard } : {};
}
function optionalDesktopHostCapabilities(cliProductPolicy) {
    return cliProductPolicy
        ? {}
        : {
            hostCapabilityRegistry: new HostCapabilityRegistry([
                createBrowserHostCapabilityAdapter(describeLocalBrowserToolInput),
                createComputerUseHostCapabilityAdapter(),
            ]),
        };
}
function optionalNormalExtensions(normalExtensions) {
    return normalExtensions ? { normalExtensions } : {};
}
export function combineAgentEventObservers(...observers) {
    const active = observers.filter((observer) => observer !== undefined);
    if (active.length === 0)
        return undefined;
    if (active.length === 1)
        return active[0];
    return {
        observeRuntimeEvent: (input) => observeAll(active, (observer) => observer.observeRuntimeEvent?.(input)),
        observeHistoryCommitted: (input) => observeAll(active, (observer) => observer.observeHistoryCommitted?.(input)),
        observeHistoryFailure: (input) => observeAll(active, (observer) => observer.observeHistoryFailure?.(input)),
    };
}
/** Projects transient provider retry state from Turn execution onto the product event stream. */
export function createSessionLLMRetryEventObserver(publish) {
    return (event) => {
        if (event.scope === 'title')
            return;
        publish({
            type: 'session.llm_retry',
            payload: { schemaVersion: 1, ...event },
        });
    };
}
async function observeAll(observers, observe) {
    const results = await Promise.allSettled(observers.map((observer) => observe(observer)));
    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length === 1)
        throw failures[0];
    if (failures.length > 1)
        throw new AggregateError(failures, 'Agent event observers failed');
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
function adaptCanonicalHistory(provider, mutation) {
    return {
        read: async (sessionId) => {
            const snapshot = await provider.read(sessionId);
            validateCanonicalHistoryMessages(snapshot.messages);
            return {
                revision: snapshot.revision,
                messages: snapshot.messages,
                identityVector: snapshot.identityVector,
            };
        },
        readActive: async (sessionId) => {
            const snapshot = await provider.readActive(sessionId);
            validateCanonicalHistoryMessages(snapshot.messages);
            return {
                revision: snapshot.revision,
                messages: snapshot.messages,
                identityVector: snapshot.identityVector,
            };
        },
        append: async (change) => {
            const committed = await provider.append(requireHistoryOperation(change));
            validateCanonicalHistoryMessages(committed.messages);
            return { ...committed, messages: committed.messages };
        },
        replace: async (change) => {
            const committed = await provider.replace(requireHistoryOperation(change));
            validateCanonicalHistoryMessages(committed.messages);
            return { ...committed, messages: committed.messages };
        },
        compact: async (change) => {
            const operation = requireHistoryOperation(change);
            if (operation.reason !== 'replaceMessages' || operation.operation.kind !== 'compaction') {
                throw new TypeError('Typed canonical compaction requires a compaction operation.');
            }
            const metadata = readCompactionCommitMetadata(operation.metadata);
            if (!metadata)
                throw new TypeError('Canonical compaction metadata is invalid.');
            const baseChange = {
                ...operation,
                reason: 'replaceMessages',
                operation: { id: operation.operation.id, kind: 'compaction' },
                compactionId: metadata.compactionId,
                summary: metadata.summary,
                ...(metadata.currentUserSourceIndex === undefined
                    ? {}
                    : {
                        currentUserSourceIndex: metadata.currentUserSourceIndex,
                        ...(metadata.placedMarkerCount === undefined
                            ? {}
                            : { placedMarkerCount: metadata.placedMarkerCount }),
                    }),
            };
            if (metadata.method !== 'llm_checkpoint') {
                const committed = await provider.compact({
                    ...baseChange,
                    method: metadata.method,
                    replacementSourceIndexes: metadata.replacementSourceIndexes,
                });
                validateCanonicalHistoryMessages(committed.messages);
                return { ...committed, messages: committed.messages };
            }
            const committed = await provider.compact({
                ...baseChange,
                method: metadata.method,
            });
            validateCanonicalHistoryMessages(committed.messages);
            return { ...committed, messages: committed.messages };
        },
        settleTurnTail: async (input) => {
            if (!mutation.settleTurnTail) {
                throw new TypeError('SessionSystem settleTurnTail capability is unavailable.');
            }
            const committed = await mutation.settleTurnTail({
                sessionId: input.sessionId,
                turnId: input.turnId,
                operationId: input.operation.id,
                mode: input.mode,
                approvedContent: input.approvedContent,
            });
            validateCanonicalHistoryMessages(committed.messages);
            return {
                revision: committed.revision,
                messages: committed.messages,
                identityVector: committed.identityVector,
                status: committed.status,
                deletedMessageIds: committed.deletedMessageIds,
            };
        },
        retractTurn: async (input) => {
            if (!mutation.retractTurn) {
                throw new TypeError('SessionSystem retractTurn capability is unavailable.');
            }
            const committed = await mutation.retractTurn({
                sessionId: input.sessionId,
                turnId: input.turnId,
                operationId: input.operation.id,
                reason: input.reason,
            });
            validateCanonicalHistoryMessages(committed.messages);
            return {
                revision: committed.revision,
                messages: committed.messages,
                identityVector: committed.identityVector,
                status: committed.status,
                deletedMessageIds: committed.deletedMessageIds,
            };
        },
    };
}
function requireHistoryOperation(change) {
    if (!change.operation)
        throw new TypeError('Canonical history operation is required.');
    return { ...change, operation: change.operation };
}
function mutableTitleContext(context) {
    return {
        systemPrompt: context.systemPrompt,
        messages: context.messages.map((message) => ({ ...message })),
        ...(context.tools ? { tools: [...context.tools] } : {}),
    };
}
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=production-composition.js.map