import { backgroundTaskNotificationReceiptId, } from '@mavis/agent-tools/desktop';
import { createV1CommerceCompatibility, createV1AttachmentRegistration, createDeferredAgentRuntimeTelemetry as createAgentTelemetryAdapter, legacyCollisionMigrationId, resolveDelegatableAgentReference, createV1AgentHostProductCapabilities, createV1MiniAppToolRules, } from './agent-host.js';
import { createDeferredPluginHookPermissionCapability, } from '@mavis/permission/plugin-hook-permission-port';
import { createDeferredContentSafetyCapability } from '@mavis/shared/local-runtime-safety';
import { createDeferredSkillRuntimeCapability } from '@mavis/shared/local-runtime-skills';
import { closeAgentDb, emitSubagentTelemetry, roleClass, SUBAGENT_TELEMETRY_EVENT, resolveTaskTarget, createLocalWorkspaceGitFacade, listFileTree, ManagedWorktreeService, managedBackendRoutingHeaders, LocalQuestionnaireService, LocalMatrixClient, SqliteQuestionnaireRequestStore, discardLocalAssetRegistrations, loadUserImages, registerMessageAttachments, resolveSessionLocalAsset, readLocalPermissionMode, replyLocalPermissionRequests, searchFiles, withAgentNameConflictMigrationScope, registerLocalAsset, scanWorkspace, updateLocalConfigFile, } from '@mavis/local-runtime';
import { createV1CronAgentCleanupBridge, createV1MavisCronAdapterBridge } from './cron.js';
import { createV1SessionCompatibility } from './session.js';
import { createV1WorkspaceLocalActionsPort, createV1WorkspaceIndexingWorker, } from './workspace-local-actions.js';
/**
 * Legacy Agent storage scope for the V2 cutover. Takes no lock: the caller
 * must hold the dataDir startup migration lock for the whole operation.
 */
export function withAgentStorageScope(dataDir, operation) {
    return withAgentNameConflictMigrationScope(dataDir, async (legacyScope) => {
        let active = true;
        const applyCollision = (nowMs) => {
            if (!active)
                throw new Error('Agent storage lock scope is no longer active');
            let result;
            let didApplyThrow = false;
            let applyError;
            try {
                result = legacyScope.applyCollision(nowMs);
            }
            catch (error) {
                didApplyThrow = true;
                applyError = error;
            }
            try {
                closeAgentDb(dataDir);
            }
            catch (closeError) {
                if (didApplyThrow) {
                    const details = applyError && typeof applyError === 'object'
                        ? applyError
                        : {};
                    throw Object.assign(new AggregateError([applyError, closeError], 'Agent storage migration apply and cached DB cleanup failed', { cause: applyError }), {
                        migrationId: legacyCollisionMigrationId(applyError),
                        failureStep: details.failureStep,
                        secondaryFailureStep: details.secondaryFailureStep,
                    });
                }
                throw Object.assign(new AggregateError([closeError], 'Agent storage migration cached DB cleanup failed', {
                    cause: closeError,
                }), { migrationId: result?.migrationId });
            }
            if (didApplyThrow)
                throw applyError;
            if (!result)
                throw new Error('legacy_agent_source_collision_apply_missing_result');
            return result;
        };
        try {
            return await operation({
                inspectLegacyAgentStorage: () => {
                    if (!active)
                        throw new Error('Agent storage lock scope is no longer active');
                    return legacyScope.inspectCollision();
                },
                applyLegacyAgentStorage: applyCollision,
                repairBuiltinAgentNameConflicts: async (input) => {
                    if (!active)
                        throw new Error('Agent storage lock scope is no longer active');
                    await legacyScope.repairBuiltinAgentNameConflicts(input);
                },
            });
        }
        finally {
            active = false;
        }
    });
}
/**
 * MR2: the v1 host exposes ONE authoritative capability bundle for channel
 * assembly; the v2 services own every store/adapter/runner. Only hosts with
 * a runtime conversation can execute channel turns.
 */
function buildChannelWireCompatibility(api) {
    return api.runtimeConversation ? { channelWire: () => api.buildChannelWireInput() } : {};
}
const TERMINAL_BACKGROUND_TASK_STATUSES = new Set(['succeeded', 'failed', 'canceled', 'lost']);
/**
 * Derives each terminal Task's notification state from durable facts only: the Task row and
 * the Turn ingress receipt its delivery bound to the admitting Turn. User-stop suppression is
 * the one process-local input, and it can only end a notification, never start one.
 */
function createBackgroundTaskNotificationProjection(api) {
    let receipts;
    return {
        bind: (next) => {
            receipts = next;
        },
        annotate: async (ownerSessionId, tasks) => {
            const terminal = tasks.filter((task) => TERMINAL_BACKGROUND_TASK_STATUSES.has(task.status));
            if (!receipts || terminal.length === 0)
                return tasks;
            const receiptIds = terminal.map(({ taskId }) => backgroundTaskNotificationReceiptId(taskId));
            let bindings;
            try {
                bindings = await receipts.findClientRequestBindings({
                    sessionId: ownerSessionId,
                    clientRequestIds: receiptIds,
                });
            }
            catch (error) {
                try {
                    api.matrixLogger?.warn({ sessionId: ownerSessionId, turnId: 'background-task-notification' }, `Background Task notification receipts could not be read: ${String(error)}`);
                }
                catch {
                    // Diagnostics are best-effort.
                }
                return tasks; // Unreadable ledger: state stays unknown (absent), read as settled.
            }
            const byReceiptId = new Map(bindings.map((binding) => [binding.clientRequestId, binding]));
            return tasks.map((task) => {
                if (!TERMINAL_BACKGROUND_TASK_STATUSES.has(task.status))
                    return task;
                const binding = byReceiptId.get(backgroundTaskNotificationReceiptId(task.taskId));
                return { ...task, notification: backgroundTaskNotificationState(api, task, binding) };
            });
        },
    };
}
function backgroundTaskNotificationState(api, task, binding) {
    // Steered into a running Turn or admitted as a new one: the owner has it, however long it runs.
    if (binding)
        return { state: 'settled', turnId: binding.turnId };
    // A result already read by a completed Turn, or a stop the user asked for, never wakes it.
    if (task.deliveredAt !== undefined || api.backgroundTasks.isDeliverySuppressed(task.taskId)) {
        return { state: 'settled' };
    }
    return { state: 'pending' };
}
/** Binds legacy Goal/session capabilities to the injected V2 background owner. */
function buildBackgroundTaskCompatibility(api, notifications) {
    return {
        bindRuntimeOwner: (owner) => api.backgroundTaskService.bindRuntimeOwner(owner),
        bindNotificationReceipts: (receipts) => notifications.bind(receipts),
        recover: async (recoveredTurnIds) => {
            await api.backgroundTaskService.reconcileStartupLostTasks({ recoveredTurnIds });
            return api.backgroundTaskService.hasPendingStartupRecovery();
        },
        pollRecovery: () => api.backgroundTaskService.pollStartupLostTasks(),
        // Pause before any task is stopped: a terminal task wakes the Session queue,
        // and a live Goal would otherwise sail through its gate and start a Turn.
        createUserStop: ({ pauseActiveGoal }) => api.backgroundTasks.createUserStopCascade(pauseActiveGoal),
    };
}
function createQuestionnaireService(host) {
    return new LocalQuestionnaireService(host.apiHost.questionnaireServiceDeps());
}
/** Owns the temporary v1/v2 reference slice; runtime.ts sees no service-specific wiring. */
export function createV1RuntimeCompatibility(conversation, factories = { createQuestionnaireService }) {
    const bridge = createV1MavisCronAdapterBridge();
    const agentCleanup = createV1CronAgentCleanupBridge();
    const globalEvents = createDeferredGlobalEventPublisher();
    const mcp = createDeferredMcpRuntimeCapability();
    const skill = createDeferredSkillRuntimeCapability();
    const pluginHookPermissions = createDeferredPluginHookPermissionCapability();
    const safety = createDeferredContentSafetyCapability();
    return {
        configureHostOptions: (options, agentResolver, ports) => ({
            ...options,
            cronConsumerEnabled: false,
            mcpRuntime: mcp.capability,
            skillRuntime: skill.capability,
            pluginHookPermissionStore: pluginHookPermissions.capability,
            contentSafety: safety.capability,
            agentResolver,
            disableLegacyConversation: true,
            deferQuestionnaireRecovery: true,
            runtimeConversation: conversation,
            globalEventPublisher: globalEvents.publish,
            mavisCronAdapterProvider: () => bridge.adapter,
            deleteAgentCronTasks: (agentName) => agentCleanup.deleteAgentCronTasks(agentName),
            workspaceIndexingEnabled: ports.workspaceIndexing.isEnabled,
            composerSendBehavior: ports.composerSendBehavior,
            skillEnabledState: ports.skillEnabledState,
            runLegacyImCredentialMigration: ports.runLegacyImCredentialMigration,
            cliSunsetNotice: ports.cliSunsetNotice,
            createBackgroundTaskRuntime: ports.createBackgroundTaskRuntime,
        }),
        createServiceCompatibility: (host, options, hostedCloudHandoff) => {
            const api = host.apiHost;
            const notifications = createBackgroundTaskNotificationProjection(api);
            const processLocal = createV1ProcessLocalSupport(host, notifications);
            const workspaceIndexing = createV1WorkspaceIndexingWorker(api);
            const workspaceLocalActions = createV1WorkspaceLocalActionsPort(api);
            const listRunningWorktreeDirs = async () => (await api.listAllSessions())
                .filter((session) => session.status === 'started')
                .map((session) => session.runLocation?.resolvedDir ?? session.workspaceDir);
            return {
                ...processLocal,
                bindQuestionnaireGoalProbe: (probe) => {
                    host.apiHost.isQuestionnaireGoalActive = probe;
                },
                goalHost: createV1GoalHostCapabilities(host),
                sandbox: {
                    eval: host.evalReporterFactory,
                    writeConfig: async (candidate) => {
                        await updateLocalConfigFile({}, new Set(['sandbox']), {
                            sandbox: structuredClone(candidate),
                        });
                    },
                },
                managedWorktrees: new ManagedWorktreeService({
                    listRunningWorktreeDirs,
                }),
                listRunningWorktreeDirs,
                workspaceIndexing,
                workspaceLocalActions,
                cron: {
                    bindAgentCleanup: (service) => {
                        agentCleanup.bind(service);
                        bridge.bindSelfReminders(service);
                    },
                    deleteAgentTasks: (agentName) => api.deleteAgentCronTasks(agentName),
                },
                modelProvider: {
                    refreshOfficialModels: () => api.refreshOfficialModels(),
                },
                memoryMigration: createV1MemoryMigrationCompatibility(api),
                agentReferences: {
                    resolveDelegatable: (requestRef) => resolveDelegatableAgentReference(api.agentResolver, requestRef, resolveTaskTarget),
                },
                agentHost: createV1AgentHostProductCapabilities(host.apiHost, host.evalReporterFactory, hostedCloudHandoff),
                generatedAssets: {
                    registerGeneratedAsset: async (input) => {
                        const record = await registerLocalAsset({
                            ...input,
                            dataDir: api.configGetter().dataDir,
                        });
                        return {
                            assetId: record.assetId,
                            absolutePath: record.absolutePath,
                            fileName: record.fileName,
                            mimeType: record.mimeType,
                            bytes: record.bytes,
                        };
                    },
                },
                promptConfig: api.configGetter().promptConfig,
                promptSnapshots: {
                    bind: (source) => api.bindPromptSnapshots(source),
                },
                internalTurnPromptReads: {
                    bind: (registry) => api.bindInternalTurnPromptReads(registry),
                },
                attachmentRegistration: createV1AttachmentRegistration(host.apiHost),
                ...buildChannelWireCompatibility(api),
                backgroundTasks: buildBackgroundTaskCompatibility(api, notifications),
                conversation: {
                    bind: async (service) => {
                        conversation.bind(service);
                    },
                    fail: (error) => conversation.fail(error),
                    shutdown: (error) => conversation.shutdown(error),
                },
                events: { bindPublisher: globalEvents.bindPublisher },
                ...(options.miniAppSurface ? { miniAppSurface: options.miniAppSurface } : {}),
                miniAppToolRules: createV1MiniAppToolRules(() => host.apiHost.permissionRouteContext()),
                safety: {
                    bind: safety.bind,
                    apiVersion: 'v2',
                    authContextGetter: api.authContextGetter,
                    authContextInvalidator: options.authContextInvalidator,
                    routingContextGetter: api.routingContextGetter,
                    fetchImpl: api.fetchImpl,
                    testBaseURLGetter: () => api.configGetter().contentReview?.testBaseURL,
                },
                greeting: {
                    canSend: () => Boolean(api.authContextGetter?.()?.accessToken?.trim()),
                    sendSystemReminder: (input) => api.sendGreetingSystemReminder(input),
                },
                questionnaires: {
                    resolveLocale: () => api.questionnaireServiceDeps().resolveLocale?.() ?? 'en',
                    createService: () => factories.createQuestionnaireService(host),
                    bindOwnedAction: (handler, onFailure) => api.bindQuestionnaireOwnedActionHandler(handler, onFailure),
                    bindRequestAdmission: (admission) => api.bindQuestionnaireRequestAdmission(admission),
                },
                sessionV2: createV1SessionCompatibility(host),
                commerce: createV1CommerceCompatibility(api, (config) => new LocalMatrixClient(config)),
                sessionHandoff: {
                    hosted: hostedCloudHandoff,
                    workspace: {
                        scan: scanSessionHandoffWorkspace,
                    },
                    cloud: {
                        authContextGetter: options.authContextGetter ?? (() => undefined),
                        ...(options.authContextInvalidator
                            ? { authContextInvalidator: options.authContextInvalidator }
                            : {}),
                        routingHeadersGetter: () => managedBackendRoutingHeaders(options.routingContextGetter?.()),
                        fetchImpl: options.fetchImpl ?? globalThis.fetch,
                    },
                },
                workspace: {
                    prepareSessionStart: (sessionId) => api.prepareWorkspaceIndexingForSessionStart(sessionId),
                    captureRevisionAfterTurn: (sessionId) => api.captureWorkspaceRevisionAfterTurn(sessionId),
                    runSessionDeletion: (sessionId, deletion) => api.runWorkspaceIndexingSessionDeletion(sessionId, deletion),
                    prewarmWorkspace: (workspaceDir) => api.prewarmWorkspaceIndexing(workspaceDir),
                    closeWorkspacePrewarm: () => api.closeWorkspaceIndexingPrewarm(),
                },
                plugin: {
                    dataDir: host.dataDir,
                    authContextGetter: options.authContextGetter ?? (() => undefined),
                    fetchImpl: options.fetchImpl ?? globalThis.fetch,
                    ...(options.appVersion ? { appVersion: options.appVersion } : {}),
                    metrics: host.metricsClient,
                },
                skillRuntime: createV1SkillRuntimeOptions(host, options, skill.bind),
                pluginHookPermissions: { bind: pluginHookPermissions.bind },
                mcp: {
                    enableLiveMcp: options.enableLiveMcp === true,
                    builtinMatrix: false,
                    matrixWebSearchOnly: false,
                    bindRuntime: mcp.bind,
                    diagnostics: host.observability,
                    ...(options.mcpLogger ? { logger: options.mcpLogger } : {}),
                    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
                },
            };
        },
        bindHandleRequest: (handleRequest) => bridge.bindHandleRequest(handleRequest),
        failConversation: (error) => conversation.fail(error),
        shutdownConversation: (error) => conversation.shutdown(error),
    };
}
function createV1MemoryMigrationCompatibility(api) {
    return {
        async disableLegacyRecall(agentName) {
            // 主 Agent 的旧目录别名属于同一个召回来源。
            const names = agentName === 'main' || agentName === 'mavis' ? ['main', 'mavis'] : [agentName];
            await api.updateConfig(Object.fromEntries(names.map((name) => [`memory.legacyRecallDisabledAgents.${name}`, true])));
        },
    };
}
async function scanSessionHandoffWorkspace(workspaceDir) {
    const result = await scanWorkspace(workspaceDir, {
        maxFiles: 15_000,
        // 与交接暂存器的内部路径边界一致，避免无关文件阻塞 Result 快照准备。
        excludedDirectoryNames: ['.git', '.mavis'],
        maxFileBytes: Number.MAX_SAFE_INTEGER,
        maxTotalBytes: Number.MAX_SAFE_INTEGER,
        // Handoff 搬运的是工作产物,不是可检索文本:PDF / Office 文档 /
        // 压缩包都是用户交给 Agent 处理的真实交接物。默认扫描面向 rg
        // 文本检索,会把它们整个挡在候选集外,导致推荐列表为空且无法补回。
        includeBinaryArtifacts: true,
    });
    if (result.status !== 'ready') {
        throw Object.assign(new Error('Workspace scan exceeds the candidate limit'), {
            code: 'WORKSPACE_SCAN_TOO_LARGE',
        });
    }
    return {
        revisionId: `sha256:${result.rootHash}`,
        files: result.files.flatMap((file) => file.kind === 'file'
            ? [
                {
                    relativePath: file.path,
                    sizeBytes: file.size,
                    sha256: file.sha256,
                    sensitive: false,
                },
            ]
            : []),
    };
}
function createDeferredGlobalEventPublisher() {
    let publisher;
    return {
        publish: (event) => publisher?.(event),
        bindPublisher: (next) => {
            publisher = next;
            return () => {
                if (publisher === next)
                    publisher = undefined;
            };
        },
    };
}
export async function cleanupFailedV1Startup(v1, closeV1, warn) {
    const steps = [
        ['stop_v1_cron', () => v1?.apiHost.cronRuntime.stop()],
        ['stop_channels', () => v1?.apiHost.shutdownChannelSubsystem()],
        ['close_v1', () => closeV1?.()],
        ['close_metrics', () => v1?.metricsClient.close()],
    ];
    for (const [cleanupStep, step] of steps) {
        try {
            await step();
        }
        catch (error) {
            try {
                warn(cleanupStep, error);
            }
            catch {
                // Cleanup and its original startup failure stay primary even if reporting fails.
            }
        }
    }
}
function createV1ProcessLocalSupport(host, notifications) {
    return {
        peripherals: createPeripheralApplication(host, notifications),
        bindPermissionShellResolver: (resolve) => host.apiHost.bindPermissionShellResolver(resolve),
    };
}
function toQuestionnaireRecord(record) {
    if (!record)
        return undefined;
    return {
        request: record.request,
        status: record.status,
        sessionId: record.sessionId,
        ...(record.agentName ? { agentName: record.agentName } : {}),
        createdAt: record.createdAt,
        ...(record.answeredAt !== undefined ? { answeredAt: record.answeredAt } : {}),
        ...(record.dismissedAt !== undefined ? { dismissedAt: record.dismissedAt } : {}),
    };
}
function createPeripheralApplication(host, notifications) {
    const questionnaires = new LocalQuestionnaireService(host.apiHost.questionnaireServiceDeps());
    const resolveQuestionnaireAgentName = async (name) => {
        const requested = name.trim();
        return requested.toLowerCase().startsWith('agent:')
            ? host.apiHost.agentResolver.requireExactAgentKey(requested)
            : requested;
    };
    return {
        questionnaires: {
            begin: async (input) => {
                const result = await questionnaires.begin(input);
                return {
                    requestId: result.requestId,
                    schemaVersion: result.schemaVersion,
                    stepCount: result.stepCount,
                };
            },
            get: async (input) => toQuestionnaireRecord(await questionnaires.get({
                ...input,
                agentName: await resolveQuestionnaireAgentName(input.agentName),
            })),
            getPending: async (input) => (await questionnaires.getPending({
                ...input,
                agentName: await resolveQuestionnaireAgentName(input.agentName),
            }))?.request ?? undefined,
            listUnanswered: async (input) => (await questionnaires.listUnansweredV2({
                ...input,
                agentName: await resolveQuestionnaireAgentName(input.agentName),
            })).map((record) => record.request),
            getLatestPlanReview: async (input) => toQuestionnaireRecord(await questionnaires.getLatestPlanReview({
                ...input,
                agentName: await resolveQuestionnaireAgentName(input.agentName),
            })),
            reply: async (input) => questionnaires.reply({
                agentName: await resolveQuestionnaireAgentName(input.agentName),
                requestId: input.requestId,
                reply: {
                    schemaVersion: 2,
                    requestId: input.requestId,
                    answers: input.answers,
                    submittedAt: input.submittedAt,
                },
            }),
            dismiss: async (input) => questionnaires.dismiss({
                ...input,
                agentName: await resolveQuestionnaireAgentName(input.agentName),
            }),
        },
        workspace: {
            git: createLocalWorkspaceGitFacade(),
            listFileTree: async ({ workspaceDir, path = '', signal }) => {
                signal?.throwIfAborted();
                const entries = await listFileTree(workspaceDir, path);
                signal?.throwIfAborted();
                return entries;
            },
            searchFiles: async ({ workspaceDir, query, limit, signal }) => {
                signal?.throwIfAborted();
                const matches = await searchFiles(workspaceDir, query, limit);
                signal?.throwIfAborted();
                return matches;
            },
        },
        permissions: {
            listPending: async ({ signal } = {}) => {
                signal?.throwIfAborted();
                return host.apiHost.permissionRouteContext().approvalService.listPending();
            },
            reply: ({ requestIds, decision }) => replyLocalPermissionRequests(host.apiHost.permissionRouteContext(), [...requestIds], decision),
            dismiss: ({ requestId }) => host.apiHost.permissionRouteContext().approvalService.dismiss(requestId),
        },
        account: {
            getStatus: ({ sessionId } = {}) => host.apiHost.getProcessLocalAccountStatus(sessionId),
        },
        diagnostics: {
            getRuntimeSnapshot: async () => host.apiHost.getProcessLocalRuntimeDiagnostics(),
        },
        configuration: {
            getPermissionMode: async () => readLocalPermissionMode(host.apiHost.configGetter().permissionMode),
            setPermissionMode: ({ mode }) => host.apiHost.setProcessLocalPermissionMode(mode),
            getPromptSuggestionEnabled: async () => host.apiHost.configGetter().promptSuggestion?.enabled === true,
            setPromptSuggestionEnabled: async ({ enabled }) => {
                // The same validated, lock-protected writer as the Desktop setting; an
                // explicit value then wins over every surface's default.
                await host.apiHost.updateConfig({ field: 'promptSuggestion.enabled', set: enabled });
                return host.apiHost.configGetter().promptSuggestion?.enabled === true;
            },
        },
        backgroundTasks: {
            list: async ({ ownerSessionId, statuses, kinds, undeliveredOnly, limit, includeNotification, }) => {
                const { items } = await host.apiHost.backgroundTaskService.list({
                    ownerSessionId,
                    ...(statuses ? { statuses: [...statuses] } : {}),
                    ...(kinds ? { kinds: [...kinds] } : {}),
                    ...(undeliveredOnly !== undefined ? { undeliveredOnly } : {}),
                    limit: Math.min(Math.max(1, limit ?? 50), 100),
                    orderBy: 'updated_at',
                    order: 'desc',
                });
                return includeNotification ? notifications.annotate(ownerSessionId, items) : items;
            },
        },
    };
}
/** Only forwards old consumers to the V2 instance; has no settings, pool or registry. */
function createDeferredMcpRuntimeCapability() {
    let current;
    const requireOwner = () => {
        if (!current)
            throw new Error('MCP runtime is not initialized or has been closed');
        return current;
    };
    return {
        capability: {
            isBuiltinMatrixAvailable: () => requireOwner().isBuiltinMatrixAvailable(),
            readConfiguredServerNames: () => requireOwner().readConfiguredServerNames(),
            createMavisAdapter: (emit) => requireOwner().createMavisAdapter(emit),
            listToolEntriesForTurn: (input) => requireOwner().listToolEntriesForTurn(input),
        },
        bind: (value) => {
            if (current)
                throw new Error('MCP runtime is already bound');
            current = value;
            return () => {
                if (current === value)
                    current = undefined;
            };
        },
    };
}
function createV1SkillRuntimeOptions(host, options, bindRuntime) {
    const api = host.apiHost;
    return {
        management: {
            runtimeOwnerKind: options.runtimeOwnerKind,
            electronHost: options.capabilities?.electronHost === true,
            resolveAgentWriteTarget: (name) => api.agentRuntimePort.resolveAgentWriteTarget(name),
            hub: {
                nowMs: options.nowMs,
                fetch: options.fetchImpl,
                authContextGetter: options.authContextGetter,
                routingContextGetter: options.routingContextGetter,
            },
        },
        configGetter: api.configGetter,
        registryDiagnostics: options.skillRegistryDiagnostics,
        resolveAgentReadScope: (name) => api.agentRuntimePort.resolveAgentReadScope(name),
        resourceAmbiguityTelemetry: {
            emitBusEvent: (type, payload) => api.emitBusEvent(type, payload),
            metrics: host.apiHost.metrics,
        },
        metricsClient: host.metricsClient,
        bindRuntime,
    };
}
/** Upper bound of one dependency scan; the task store caps a page at this size. */
const UNFINISHED_BACKGROUND_TASK_SCAN_LIMIT = 500;
function createV1GoalHostCapabilities(host) {
    const api = host.apiHost;
    const questionnaireStore = new SqliteQuestionnaireRequestStore(() => host.dataDir);
    return {
        questionnaires: () => new LocalQuestionnaireService(api.questionnaireServiceDeps()).ownedOperations(),
        hasUnresolvedQuestionnaire: (sessionId) => questionnaireStore.hasUnresolvedBySession(sessionId),
        hasPendingPermission: (sessionId) => api.hasPendingPermissionForSession(sessionId),
        hasActiveTeamOwner: (sessionId) => api.hasActiveTeamOwner(sessionId),
        listUnfinishedBackgroundTasks: async (sessionId, kinds) => (await api.backgroundTaskService.list({
            ownerSessionId: sessionId,
            kinds: [...kinds],
            statuses: ['queued', 'running', 'stopping'],
            limit: UNFINISHED_BACKGROUND_TASK_SCAN_LIMIT,
        })).items.map((task) => {
            // Every local task row records the Turn whose tool call started it.
            const parentTurnId = task.metadata?.parentTurnId;
            return {
                kind: task.kind,
                ...(typeof parentTurnId === 'string' && parentTurnId
                    ? { startedByTurnId: parentTurnId }
                    : {}),
            };
        }),
        readSessionFacts: async (sessionId) => {
            const session = await api.getSessionById(sessionId);
            return session
                ? {
                    agentName: session.agentName,
                    parentSessionId: session.parentSessionId,
                    sessionType: session.sessionType,
                    sessionKind: session.sessionKind,
                    ...(session.purpose ? { purpose: session.purpose } : {}),
                }
                : undefined;
        },
        isReadOnlyLegacySession: (sessionId) => api.isReadOnlyLegacySession(sessionId),
        bindQuestionnaireWorkOwner: (owner) => api.bindQuestionnaireWorkOwner(owner),
        bindSubSessionRoundAttribution: (port) => api.bindSubSessionRoundAttribution(port),
        objectiveAssets: {
            resolve: ({ sessionId, assetId }) => resolveSessionLocalAsset({ dataDir: host.dataDir, sessionId, assetId }),
            register: ({ sessionId, attachments }) => registerMessageAttachments({ dataDir: host.dataDir, sessionId, attachments }),
            discard: async ({ sessionId, receipts }) => {
                await discardLocalAssetRegistrations({ dataDir: host.dataDir, sessionId, receipts });
            },
        },
        loadObjectiveImages: loadUserImages,
        verifierTaskRunner: {
            hasSession: async (sessionId) => Boolean(await api.getSessionById(sessionId)),
            inheritSessionRestrictions: (input) => api.inheritSessionPermissionRestrictions(input),
            runForeground: (input) => api.runForegroundDelegation(input),
        },
        observability: {
            logger: host.observability,
            ...(host.evalReporterFactory ? { evalReporterFactory: host.evalReporterFactory } : {}),
        },
    };
}
export function createDeferredAgentRuntimeTelemetry() {
    return createAgentTelemetryAdapter({
        emitSubagentTelemetry,
        roleClass,
        events: SUBAGENT_TELEMETRY_EVENT,
    });
}
//# sourceMappingURL=runtime.js.map