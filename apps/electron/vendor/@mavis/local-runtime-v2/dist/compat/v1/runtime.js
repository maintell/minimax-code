import { createDeferredPluginHookPermissionCapability, } from '@mavis/permission/plugin-hook-permission-port';
import { createDeferredContentSafetyCapability } from '@mavis/shared/local-runtime-safety';
import { createDeferredSkillRuntimeCapability } from '@mavis/shared/local-runtime-skills';
import { buildCompressedModelImageFromBuffer, closeAgentDb, createUserStopCascade, createLocalWorkspaceGitFacade, emitSubagentTelemetry, listFileTree, ManagedWorktreeService, managedBackendRoutingHeaders, LocalQuestionnaireService, readLocalPermissionMode, replyLocalPermissionRequests, resolveTaskTarget, searchFiles, ThreadGoalContractError, withAgentNameConflictMigrationLock, roleClass, registerLocalAsset, SUBAGENT_TELEMETRY_EVENT, scanWorkspace, updateLocalConfigFile, } from '@mavis/local-runtime';
import { createV1CronAgentCleanupBridge, createV1MavisCronAdapterBridge } from './cron.js';
import { createV1AttachmentRegistration, createV1AgentHostProductCapabilities, } from './agent-host.js';
import { createV1SessionCompatibility } from './session.js';
/**
 * Validates a persisted Agent mention through the same trusted v1 resolver
 * chain that Task uses. The primary family is intentionally excluded: a main
 * session may nominate only a delegatable SubAgent, never itself.
 */
async function resolveDelegatableAgentReference(resolver, requestRef) {
    try {
        const scope = await resolver.resolveAgentReadScope(requestRef);
        if (scope.canonicalName === scope.primaryName)
            return 'unauthorized';
        await resolveTaskTarget(resolver, requestRef);
        return 'authorized';
    }
    catch {
        // Resolver failures must neither reveal roster details nor emit Task text.
        return 'unknown';
    }
}
/** Cross-process cutover lock shared with the legacy conflict migration. */
export function withAgentStorageLock(dataDir, operation) {
    return withAgentNameConflictMigrationLock(dataDir, async (legacyScope) => {
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
function legacyCollisionMigrationId(error) {
    const migrationId = error && typeof error === 'object' && 'migrationId' in error
        ? error.migrationId
        : undefined;
    return typeof migrationId === 'string' && /^agent-name-conflicts-\d+$/u.test(migrationId)
        ? migrationId
        : undefined;
}
/** Deferred, fail-open adapter for Agent facts emitted before v1 host binding. */
export function createDeferredAgentRuntimeTelemetry() {
    let sink;
    let closed = false;
    const facts = {
        onNameCompatResolve: (fact) => {
            emitSubagentTelemetry(sink, SUBAGENT_TELEMETRY_EVENT.nameCompatResolve, {
                intent: fact.intent,
                canonical_class: fact.canonicalClass,
                source: fact.source,
                success: fact.success,
                ...(fact.memberCountBucket ? { member_count_bucket: fact.memberCountBucket } : {}),
                ...(fact.errorCode ? { error_code: fact.errorCode } : {}),
            });
        },
        onAgentRoleObservation: (fact) => {
            emitSubagentTelemetry(sink, SUBAGENT_TELEMETRY_EVENT.agentRoleObservation, {
                status: fact.status,
                source: fact.source,
                role_class: roleClass(fact.role),
            });
        },
        // Emitted on EVERY overlay branch, including the skips. "My old display
        // name did not carry over" must be answerable from one event, not from
        // the absence of a repository write.
        onPrimaryProfileOverlay: (fact) => {
            emitSubagentTelemetry(sink, SUBAGENT_TELEMETRY_EVENT.primaryProfileOverlay, {
                outcome: fact.outcome,
                // Field names only: a displayName or workspace path is user content.
                adopted_fields: fact.adoptedFields.join(','),
                adopted_count: fact.adoptedFields.length,
                display_name_locked: fact.displayNameLocked,
            });
        },
    };
    return {
        facts,
        bind: (input) => {
            if (closed)
                return;
            sink = createAgentTelemetryHost(input);
        },
        close: () => {
            closed = true;
            sink = undefined;
        },
    };
}
function createAgentTelemetryHost(input) {
    const client = input.metricsClient;
    return {
        metrics: {
            incr: (name, labels) => client.counter(name, 1, labels),
            gauge: (name, value, labels) => client.gauge(name, value, labels),
            latency: (name, durationMs, labels) => client.histogram(name, durationMs, labels),
        },
        ...(input.emitBusEvent ? { emitBusEvent: input.emitBusEvent } : {}),
    };
}
/**
 * MR2: the v1 host exposes ONE authoritative capability bundle for channel
 * assembly; the v2 services own every store/adapter/runner. Only hosts with
 * a runtime conversation can execute channel turns.
 */
function buildChannelWireCompatibility(api) {
    return api.runtimeConversation ? { channelWire: () => api.buildChannelWireInput() } : {};
}
/**
 * V1-owned background task seam. Extracted from the composition function purely
 * to keep it readable; the user-stop cascade lives here because V1 holds the
 * task runners and their per-process admissions.
 */
function buildBackgroundTaskCompatibility(api) {
    return {
        bindRuntimeOwner: (owner) => api.backgroundTaskService.bindRuntimeOwner(owner),
        recover: async (recoveredTurnIds) => {
            await api.backgroundTaskService.reconcileStartupLostTasks({ recoveredTurnIds });
            return api.backgroundTaskService.hasPendingStartupRecovery();
        },
        pollRecovery: () => api.backgroundTaskService.pollStartupLostTasks(),
        userStop: createUserStopCascade({
            host: api,
            // Pause before any task is stopped: a terminal task wakes the Session queue,
            // and a live Goal would otherwise sail through its gate and start a Turn.
            pauseActiveGoal: (sessionId) => api.threadGoal.pauseActiveGoalForAbort(sessionId),
        }),
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
        }),
        createServiceCompatibility: (host, options, hostedCloudHandoff) => {
            const api = host.apiHost;
            const processLocal = createV1ProcessLocalSupport(host);
            return {
                ...processLocal,
                sandbox: {
                    eval: host.evalReporterFactory,
                    writeConfig: async (candidate) => {
                        await updateLocalConfigFile({}, new Set(['sandbox']), {
                            sandbox: structuredClone(candidate),
                        });
                    },
                },
                managedWorktrees: new ManagedWorktreeService({
                    listRunningWorktreeDirs: async () => (await api.listAllSessions())
                        .filter((session) => session.status === 'started')
                        .map((session) => session.runLocation?.resolvedDir ?? session.workspaceDir),
                }),
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
                    resolveDelegatable: (requestRef) => resolveDelegatableAgentReference(api.agentResolver, requestRef),
                },
                agentHost: createV1AgentHostProductCapabilities(host.apiHost, host.evalReporterFactory, hostedCloudHandoff),
                generatedAssets: {
                    compressModelImage: (input) => {
                        const compressed = buildCompressedModelImageFromBuffer(Buffer.from(input.bytes), input.fileName, undefined, input.budget);
                        return compressed
                            ? {
                                dataUrl: compressed.filePart.url,
                                width: compressed.width,
                                height: compressed.height,
                            }
                            : undefined;
                    },
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
                backgroundTasks: buildBackgroundTaskCompatibility(api),
                conversation: {
                    bind: async (service) => {
                        await api.recoverThreadGoalKickoffs(service);
                        conversation.bind(service);
                    },
                    fail: (error) => conversation.fail(error),
                    shutdown: (error) => conversation.shutdown(error),
                },
                events: { bindPublisher: globalEvents.bindPublisher },
                ...(options.miniAppSurface ? { miniAppSurface: options.miniAppSurface } : {}),
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
function createV1ProcessLocalSupport(host) {
    return {
        peripherals: createPeripheralApplication(host),
    };
}
function createPeripheralApplication(host) {
    const questionnaires = new LocalQuestionnaireService(host.apiHost.questionnaireServiceDeps());
    return {
        goals: createThreadGoalApplication(host.apiHost.threadGoal, (sessionId) => host.apiHost.isReadOnlyLegacySession(sessionId)),
        questionnaires: {
            getPending: async (input) => (await questionnaires.getPending(input))?.request ?? undefined,
            getLatestPlanReview: async (input) => (await questionnaires.getLatestPlanReview(input))?.request ?? undefined,
            reply: async (input) => questionnaires.reply({
                agentName: input.agentName,
                requestId: input.requestId,
                reply: {
                    schemaVersion: 2,
                    requestId: input.requestId,
                    answers: input.answers,
                    submittedAt: input.submittedAt,
                },
            }),
            dismiss: (input) => questionnaires.dismiss(input),
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
        },
        backgroundTasks: {
            list: async ({ ownerSessionId, statuses, kinds, undeliveredOnly, limit }) => (await host.apiHost.backgroundTaskService.list({
                ownerSessionId,
                ...(statuses ? { statuses: [...statuses] } : {}),
                ...(kinds ? { kinds: [...kinds] } : {}),
                ...(undeliveredOnly !== undefined ? { undeliveredOnly } : {}),
                limit: Math.min(Math.max(1, limit ?? 50), 100),
                orderBy: 'updated_at',
                order: 'desc',
            })).items,
        },
    };
}
/** Process-local facade over the authoritative v1 Thread Goal integration. */
function createThreadGoalApplication(integration, isReadOnlyLegacySession) {
    const requireEnabled = () => {
        if (!integration.isEnabled())
            throw new Error('Thread Goal is disabled.');
    };
    const assertMutable = async (sessionId) => {
        if (await isReadOnlyLegacySession(sessionId)) {
            throw new Error('Legacy opencode sessions are read-only in clean local-runtime mode.');
        }
    };
    return {
        isEnabled: () => integration.isEnabled(),
        get: async (sessionId) => {
            requireEnabled();
            const state = await integration.getGoalForResponse(requireGoalSessionId(sessionId));
            return state ? toGlobalThreadGoal(state) : undefined;
        },
        create: async ({ sessionId, objective: rawObjective, tokenBudget, kickoffAttachments }) => {
            requireEnabled();
            const normalizedSessionId = requireGoalSessionId(sessionId);
            await assertMutable(normalizedSessionId);
            const objective = requireGoalObjective(rawObjective);
            const input = {
                sessionId: normalizedSessionId,
                objective,
                ...(tokenBudget !== undefined ? { tokenBudget } : {}),
                ...(kickoffAttachments?.length ? { kickoffAttachments } : {}),
            };
            const created = kickoffAttachments?.length
                ? await integration.createGoal(input, { requireKickoffAdmission: true })
                : await integration.createGoal(input);
            return toGlobalThreadGoal(created);
        },
        patch: async (sessionId, patch) => {
            requireEnabled();
            const normalizedSessionId = requireGoalSessionId(sessionId);
            await assertMutable(normalizedSessionId);
            // Same intent split as the HTTP route: a bare `paused` is the user
            // leaving the Goal and must take the atomic lifecycle transition, not
            // the generic field patch.
            const updated = isBareUserPause(patch)
                ? await integration.pauseGoalByUser(normalizedSessionId)
                : await integration.patchGoal(normalizedSessionId, normalizeProcessLocalGoalPatch(patch));
            if (!updated)
                throw goalNotFound(normalizedSessionId);
            return toGlobalThreadGoal(updated);
        },
        clear: async (sessionId) => {
            requireEnabled();
            const normalizedSessionId = requireGoalSessionId(sessionId);
            await assertMutable(normalizedSessionId);
            if (!(await integration.deleteGoal(normalizedSessionId))) {
                throw goalNotFound(normalizedSessionId);
            }
            return true;
        },
    };
}
function goalNotFound(sessionId) {
    return new ThreadGoalContractError(404, `Goal not found for session: ${sessionId}`, 'GOAL_NOT_FOUND');
}
function normalizeGoalObjectivePatch(objective) {
    return objective === undefined ? undefined : requireGoalObjective(objective);
}
/**
 * A bare `status: 'paused'` carries the user's intent to leave the Goal.
 * Anything paired with an objective or budget edit stays a field patch.
 */
function isBareUserPause(patch) {
    return (patch.status === 'paused' && patch.objective === undefined && patch.tokenBudget === undefined);
}
function normalizeProcessLocalGoalPatch(patch) {
    const objective = normalizeGoalObjectivePatch(patch.objective);
    if (patch.status === undefined && objective === undefined && patch.tokenBudget === undefined) {
        throw new Error('Goal patch must include status, objective, or tokenBudget.');
    }
    return {
        ...(patch.status ? { status: patch.status } : {}),
        ...(objective !== undefined ? { objective } : {}),
        ...(patch.tokenBudget !== undefined ? { tokenBudget: patch.tokenBudget } : {}),
    };
}
function toGlobalThreadGoal(state) {
    return {
        goalId: state.goalId,
        sessionId: state.sessionId,
        objective: state.objective,
        status: state.status,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        tokensUsed: state.tokensUsed,
        turnsUsed: state.turnsUsed,
        timeUsedSeconds: state.timeUsedSeconds,
        tokenBudget: state.tokenBudget,
        statusReason: state.statusReason,
        executionWait: state.executionWait,
        ...(state.lastVerification !== undefined
            ? {
                lastVerification: {
                    backend: state.lastVerification.backend,
                    verdict: state.lastVerification.verdict,
                    reason: state.lastVerification.reason,
                    missing: [...state.lastVerification.missing],
                    notMetStreak: state.lastVerification.notMetStreak,
                    at: state.lastVerification.at,
                },
            }
            : {}),
        hasKickoffAttachments: state.kickoffAttachments.length > 0,
    };
}
function requireGoalSessionId(value) {
    const sessionId = value.trim();
    if (!sessionId)
        throw new Error('sessionId is required.');
    return sessionId;
}
function requireGoalObjective(value) {
    const objective = value.trim();
    if (!objective)
        throw new Error('goal objective must not be empty');
    return objective;
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
//# sourceMappingURL=runtime.js.map