import { composeAgentShell, withAgentShellPermission, } from './application/session/agent-shell-composition.js';
import { bindBackgroundTaskApplications } from './application/session/background-task-application.js';
import { initializeSkillSystem } from './service/skill/index.js';
import { createComputerUseDefaultPreference, createComputerUsePreferenceStore, createComputerUsePluginCallbacks, deactivateComputerUsePlugin, restoreRuntimeComputerUsePreferences, } from './service/computer-use/index.js';
import { CloudSessionReader } from '@mavis/agent-tools/desktop';
import { getRuntimeRegion, getRuntimeBuildEnv, } from '@mavis/config';
import { createQueryCollapseKeyResolver, } from './application/conversation/index.js';
import { createRuntimeMessageDelivery } from './application/conversation/runtime-message-delivery.js';
import { createRuntimeAuthRecoveryNotifier } from './application/session/runtime-execution-auth.js';
import { createRuntimeWorkspace, createRuntimeNormalExtensions, createServiceGlobalEventWriter, bindRuntimeHostedCloudHandoff, requirePreparedSkillState, prepareRuntimeServices, initializeRuntimeSandbox, initializeRuntimeCron, resolveServicesCompatibility, } from './application/session/runtime-services-composition.js';
import { AgentApplication, AppError, createRuntimeAgentApplication, configureRuntimePluginHooks, createRuntimePluginSessionLifecycle, createRuntimeServicesLifecycle, bindGoalConversation, startupRecoveryControls, startupRecoveryInputs, closeRuntimeServiceOwnersAfterFailure, createRuntimeSkillApplication, createRuntimeBrowserUseComposition, createGoalEvaluatorVerifier, createGoalSubagentVerifierRuntime, initializeApplications, ownsElectronRuntimeCapabilities, ModelProviderApplication, } from './application/index.js';
import { createRuntimeProcessLocalApplication, createRuntimeUserApplications, } from './application/session/runtime-user-applications.js';
import { createGoalVerificationTranscriptReader } from './application/agent/goal-verification-transcript.js';
import { createRuntimeGoalApplications, } from './application/session/goal-application.js';
import { createProductionConversationMutationWorkflow, unavailableForkWorktree, } from './application/session/conversation-mutation-workflow.js';
import { bindTaskAgentBindingCapture } from './application/session/task-agent-ready-inventory.js';
import { createForkState } from './application/session/conversation-fork-state.js';
import { createSessionTurnLifecycleEvents, } from './application/session/turn-lifecycle-event-observer.js';
import { createQueueWakeFailureReporter, describeError, reportRootBestEffortFailure, } from './application/session/turn-message-delivery.js';
import { initializeRuntimeCanvas } from './service/canvas/index.js';
import { createSessionHandoffComposition } from './service/session-handoff/index.js';
import { initializeRuntimeTurnSystem } from './application/session/turn-system-composition.js';
import { composeSessionClio, } from './service/session-clio/index.js';
import { buildCompatChannelSystemOwner, } from './service/channel-system/index.js';
import { initializeManagedContentSafetyService, } from './service/content-safety/index.js';
import { createOptionalRuntimeCronTurnDelivery, hasActiveCronSessionOwner, listCronTargetSessionIds, } from './service/cron/index.js';
import { AgentFavorites } from './service/agent/index.js';
import { bindRuntimeServicePromptLifecycle, withRuntimePromptSupportRollback, } from './service/prompt-config/index.js';
import { createRuntimePromptSessionSupport } from './application/session/runtime-prompt-support.js';
import { createRuntimeInspector, } from './service/llm-context-inspector/index.js';
import { initializeRuntimeMemoryV2System, } from './service/memory-system/index.js';
import { memoryDesktopApplicationFor, } from './application/memory/memory-desktop-application.js';
import { initializeSessionApplicationSystem, createComposerPreferences, } from './service/session-system/index.js';
import { initializePluginHookPermissions, initializePluginService, createPluginNameReservations, } from './service/plugin-system/index.js';
import { resolvePluginServiceLogger } from './application/session/plugin-service-logger.js';
import { bindMiniAppAgentSessions, createRuntimeMiniAppAgent, miniAppHostVersion, } from './application/session/miniapp-agent-wiring.js';
import { createMiniAppLocalMcpTools, initializeMcpService, } from './service/mcp/index.js';
import { composeMiniAppRuntimeCapability, createMiniAppToolPermissions, createDeferredRuntimeOwnersLifecycle, resolveRuntimeMiniAppOptions, } from './service/miniapp/index.js';
import { bindConversationMutationPlanState, initializePlanService, createPlanEntryReaders, } from './service/plan/index.js';
import { AgentHostTurnCapabilityLifecycle, deactivateLocalPluginHooks, disposeLocalPluginHookSessions, requireTurnSystem, } from './service/turn-system/index.js';
import { composeV1Conversation } from './service/v1-conversation-compat/index.js';
export { bindAskUserRuntimeProbes } from './application/session/questionnaire-runtime-probes.js';
export { createRuntimeAgentComposition, } from './service/agent/index.js';
export { createDeferredLocalSandboxBashOperationsFactory, } from './service/sandbox/index.js';
export { prepareRuntimeServices, } from './application/session/runtime-services-composition.js';
/**
 * Builds SessionSystem, the Plugin service, optional Channel/Cron owner
 * capabilities, AgentHost, and TurnSystem over that graph.
 */
export async function createRuntimeServices(creation) {
    const compatibility = resolveServicesCompatibility(creation.compatibility);
    const safety = initializeManagedContentSafetyService(compatibility.safety);
    let hookPermissions;
    try {
        hookPermissions = initializePluginHookPermissions({
            dataDir: creation.dataDir,
            bind: compatibility.pluginHookPermissions.bind,
        });
        return await composeRuntimeServices({ ...creation, compatibility }, safety, hookPermissions);
    }
    catch (error) {
        await hookPermissions?.close();
        await safety.close();
        throw error;
    }
}
async function composeRuntimeServices(creation, safety, hookPermissions) {
    const { options, browserUseComposition, nowMs, processStartedAtMs, ownerLifecycle, state, computerUse, sandbox, bindSessionSystem, inspector, writeGlobalEvent, turnCapabilities, globalInstructions, promptSupport, productionSessionComposition, agentSessionPorts, promptConfig, internalTurnPromptReads, agentShell, } = await prepareRuntimeServiceComposition(creation, safety);
    bindSessionSystem(productionSessionComposition.sessionSystem);
    const { product: baseProduct, preparation, modelSystem, modelProviderApplication, sessionSystem, pinService, archiveTitleModel, facts, channelTurnAdmission, goal, goalPort, bindGoalCronOwnerReader, } = productionSessionComposition;
    // Windows-only: the first native Bash call waits for the Session shell binding, so the
    // permission gate must resolve the very same AgentShell instance that owns that binding.
    const product = withAgentShellPermission(baseProduct, agentShell);
    const { planEntryEnabled, agentPlanEntryEnabled } = createPlanEntryReaders(product.preparation.configBuilder.config);
    const canvas = initializeRuntimeCanvas(options, sessionSystem);
    const workspace = createRuntimeWorkspace(options, sessionSystem, writeGlobalEvent);
    const promptBoundOwners = await initializePromptBoundRuntimeServiceOwners({
        options,
        processStartedAtMs,
        product,
        preparation,
        sessionSystem,
        modelProviderApplication,
        pinService,
        canvas,
        archiveTitleModel,
        facts,
        channelTurnAdmission,
        goal,
        goalPort,
        bindGoalCronOwnerReader,
        safety,
        turnCapabilities,
        agentSessionPorts,
        agentService: options.agentService,
        internalTurnPromptReads,
        writeGlobalEvent,
        nowMs,
        enableCron: ownsScheduledRuntimeCapabilities(options.runtimeOwnerKind),
        runtimeOwnerIdentity: options.runtimeOwnerIdentity,
        planEntryEnabled,
        agentPlanEntryEnabled,
        inspector,
        promptSupport,
        enableChannel: ownsElectronRuntimeCapabilities(options.runtimeOwnerKind),
        workspaceIndexing: workspace.indexing,
        readyOwners: ownerLifecycle.ready,
        closeOwners: ownerLifecycle.close,
    });
    const { channelSystem, owners, queryCollapseKeys, sessionClio } = promptBoundOwners;
    state.agentApplication = owners.agentApplication;
    const { conversation, skill } = createRuntimeUserApplications({
        options,
        owners,
        goalPort,
        sessionSystem,
        queryCollapseKeys,
        workspaceIndexing: workspace.indexing,
        agentSessionPorts,
        nowMs,
        createSkillApplication: createRuntimeSkillApplication,
    });
    const goalApplications = createRuntimeGoalApplications(goal.service, (sessionId) => options.compatibility.goalHost.isReadOnlyLegacySession(sessionId));
    const application = createRuntimeProcessLocalApplication({
        goals: goalApplications.processLocal,
        options,
        owners,
        sessionSystem,
        skill,
        planEntryEnabled,
        modelSystem,
        modelProviderApplication,
    });
    if (owners.cron)
        options.compatibility.cron.bindAgentCleanup(owners.cron.service);
    const cronDelivery = createOptionalRuntimeCronTurnDelivery(Boolean(owners.cron), options.overrides?.cron?.turnDelivery, owners.turnSystem.turns, product.executor.reportFailure);
    const lifecycle = createRuntimeServicesLifecycle({
        recoverPersistedState: options.recoverPersistedState,
        state,
        bindGlobalEventPublisher: () => options.compatibility.events.bindPublisher(writeGlobalEvent),
        reportFailure: options.compatibility.agentHost.executor.reportFailure,
        bindConversation: bindGoalConversation(goal, options, owners.runtimeConversation),
        ...startupRecoveryInputs(goal, options, owners.runtimeConversation),
        shutdownConversation: () => options.compatibility.conversation.shutdown(),
        disposePluginHookSessions: disposeLocalPluginHookSessions,
        sessionSystem,
        workspaceGit: workspace.git,
        workspaceHtmlPreview: workspace.htmlPreview,
        workspaceFile: workspace.file,
        workspaceIndexing: workspace.indexing,
        sandbox,
        closeBrowserUse: browserUseComposition.close,
        ...owners,
    });
    const pluginHooks = configureRuntimePluginHooks({ ...options, nowMs, ...owners });
    const promptLifecycle = bindRuntimeServicePromptLifecycle({
        compatibility: options.compatibility,
        support: promptSupport,
        lifecycle,
    });
    ownerLifecycle.bind({
        ready: promptLifecycle.ready,
        close: () => closeRuntimeServiceResources(promptLifecycle, hookPermissions, safety),
    });
    return {
        agentShell,
        agent: owners.agentApplication,
        safety,
        canvas,
        cron: owners.cron?.service,
        ...(cronDelivery ? { cronDelivery } : {}),
        globalEvents: { subscribe: (subscriber) => options.eventBus.subscribe(subscriber) },
        managedWorktrees: options.compatibility.managedWorktrees,
        workspace,
        sessionSystem,
        pinService,
        globalInstructions,
        agentFavorites: new AgentFavorites(options.db, options.agentService),
        ...createComposerPreferences(options.db),
        ...(channelSystem ? { channelSystem } : {}),
        turnSystem: owners.turnSystem,
        browserUse: browserUseComposition.service,
        processLifecycle: owners.turnSystem.processLifecycle,
        conversation,
        applications: owners.applications,
        application,
        plugin: owners.plugin.plugin,
        mcp: owners.mcp.service,
        mcpRuntime: owners.mcp.runtime,
        hookConfig: pluginHooks.hookConfig,
        modelSystem,
        modelProviderApplication,
        skill,
        skillEvolve: owners.skillSystem.evolve,
        ...computerUse,
        computerUseDefaultPreference: composeComputerUseDefaultPreference(options),
        sandbox,
        ...(inspector ? { llmContextInspector: inspector.service } : {}),
        goal: goalApplications.http,
        ...memoryDesktopApplicationFor(owners.memory),
        ...owners.miniAppComposition.services,
        notifyAuthContextChanged: createRuntimeAuthRecoveryNotifier({
            mode: options.executionAuthMode,
            isClosed: () => state.closed,
            notifyPluginContextChanged: pluginHooks.notifyAuthContextChanged,
            promptConfig,
            recoverQuestionnaires: async () => {
                await options.compatibility.questionnaires.createService().recoverOnStartup();
            },
            reconcilePlan: () => owners.plan.lifecycleReconciler.schedule('auth-context-ready'),
            listPendingSessionIds: () => sessionSystem.queue.committed.listPendingSessionIds(),
            dispatchQueue: (sessionId) => owners.turnSystem.turns.dispatchQueue(sessionId),
            reportFailure: (scope, message) => product.executor.reportFailure?.(scope, message),
        }),
        builtinAgentDefinitionsReady: lifecycle.builtinAgentDefinitionsReady,
        ready: owners.miniAppComposition.ready,
        ...startupRecoveryControls(lifecycle, () => closeRuntimeOwners(sessionClio, owners.miniAppComposition, goal)),
    };
}
async function closeRuntimeServiceResources(promptLifecycle, hookPermissions, safety) {
    try {
        await promptLifecycle.close();
    }
    finally {
        try {
            await hookPermissions.close();
        }
        finally {
            await safety.close();
        }
    }
}
function ownsScheduledRuntimeCapabilities(runtimeOwnerKind) {
    return ownsElectronRuntimeCapabilities(runtimeOwnerKind) || runtimeOwnerKind === 'app-server';
}
function composeComputerUseDefaultPreference(options) {
    return createComputerUseDefaultPreference({
        preferences: options.computerUsePreferences,
        clientAvailable: Boolean(options.computerUseClient),
        scope: () => {
            const principalId = options.compatibility.plugin.authContextGetter()?.realUserID?.trim();
            return principalId
                ? { principalId, deployment: `${getRuntimeRegion()}-${getRuntimeBuildEnv()}` }
                : undefined;
        },
    });
}
/** Closes owners in order; every owner is closed even when an earlier one fails. */
function closeRuntimeOwners(sessionClio, miniApp, goal) {
    sessionClio?.close();
    // Stop Goal account-quota recovery timers; the durable rows keep each schedule.
    goal.close();
    return miniApp.close();
}
function planFailureReporter(product, stage) {
    return (error) => {
        product.executor.reportFailure?.('plan-lifecycle', `owner=plan;stage=${stage};error=${describeError(error)}`);
    };
}
/** What `context.tool` reaches beyond Plugin MCP; each port is optional on non-desktop hosts. */
function miniAppToolHostPorts(compatibility, mcpRuntime) {
    const requestApproval = compatibility.miniAppSurface?.requestToolApproval;
    return {
        localMcp: createMiniAppLocalMcpTools(mcpRuntime),
        ...(compatibility.miniAppToolRules
            ? { permissions: createMiniAppToolPermissions(compatibility.miniAppToolRules) }
            : {}),
        ...(requestApproval ? { approvals: { request: (request) => requestApproval(request) } } : {}),
    };
}
async function initializeRuntimeServiceOwners(input) {
    const pluginLogger = resolvePluginServiceLogger(input.options.logger);
    const miniAppOptions = resolveRuntimeMiniAppOptions(input.options);
    const miniAppAgent = miniAppOptions ? createRuntimeMiniAppAgent(input, pluginLogger) : undefined;
    let plugin;
    let mcp;
    let skillSystem;
    let turnSystem;
    let cron;
    let miniAppComposition;
    let resumeSessionDeletion;
    try {
        mcp = initializeMcpService({
            ...input.options.compatibility.mcp,
            dataDir: input.options.dataDir,
            nowMs: input.nowMs,
            metrics: input.options.metrics,
        });
        const mcpRuntime = mcp.runtime;
        skillSystem = initializeSkillSystem({
            ...input.options.compatibility.skillRuntime,
            management: {
                ...input.options.compatibility.skillRuntime.management,
                reviewContent: input.safety.review,
            },
            enabledState: requirePreparedSkillState(input.options),
            readMcpServerNames: () => mcpRuntime.readConfiguredServerNames(),
        });
        plugin = initializePluginService({
            ...input.options.compatibility.plugin,
            ...miniAppHostVersion(input.options),
            listStandaloneSkills: skillSystem.management.listSkills,
            standaloneSkillIdentities: skillSystem.installedIdentities,
            ...createComputerUsePluginCallbacks(input.options.computerUseClient, input.options.computerUsePreferences),
            mcp: mcpRuntime,
            skill: skillSystem.runtime,
            listReservations: createPluginNameReservations(skillSystem.runtime, mcpRuntime),
            database: input.options.db,
            logger: pluginLogger,
        }, input.turnCapabilities, (pluginName) => {
            deactivateLocalPluginHooks(pluginName);
            deactivateComputerUsePlugin(input.options.computerUseClient, pluginName);
        });
        bindTaskAgentBindingCapture(input, { plugin, mcp }, pluginLogger);
        miniAppAgent?.bindPermissionSwitches(plugin.miniAppPermissionSwitches);
        miniAppComposition = await composeMiniAppRuntimeCapability({
            options: miniAppOptions,
            db: input.options.db,
            dataDir: input.options.dataDir,
            nowMs: input.nowMs,
            plugin,
            agentGateway: miniAppAgent,
            tools: miniAppToolHostPorts(input.options.compatibility, mcpRuntime),
            logger: pluginLogger,
            readyOwners: input.readyOwners,
            closeOwners: input.closeOwners,
        });
        const normalExtensions = createRuntimeNormalExtensions({
            miniApp: {
                plugins: plugin,
                supervisor: miniAppComposition.services.miniApp,
                sessions: input.sessionSystem.sessions.repository,
                surface: input.options.compatibility.miniAppSurface,
                logger: pluginLogger,
            },
        });
        const plan = initializePlanService({
            db: input.options.db,
            modes: input.sessionSystem.sessions.interactionMode,
            documents: input.sessionSystem.planDocuments,
            questionnaires: input.options.compatibility.questionnaires,
            queue: input.sessionSystem.queue.committed,
            receipts: {
                findReceipt: (turnId) => requireTurnSystem(turnSystem).receipts.findReceipt(turnId),
            },
            dispatchQueue: (sessionId) => requireTurnSystem(turnSystem).turns.dispatchQueue(sessionId),
            entryEnabled: input.planEntryEnabled,
            agentEntryEnabled: input.agentPlanEntryEnabled,
            reportFailure: planFailureReporter(input.product, 'lifecycle-reconcile'),
            reportReviewFallbackFailure: planFailureReporter(input.product, 'review-fallback'),
            nowMs: input.nowMs,
        });
        bindConversationMutationPlanState({
            mutationState: input.sessionSystem.conversationMutationState,
            modes: input.sessionSystem.sessions.interactionMode,
            lifecycleFence: plan.lifecycleFence,
        });
        const subagentVerification = createGoalSubagentVerifierRuntime({
            createExecution: (registry) => input.goal.createVerifierExecution(registry),
            config: input.product.preparation.configBuilder.config,
            nowMs: input.nowMs,
        });
        turnSystem = await initializeRuntimeTurnSystem(input, {
            plan,
            prepareMiniAppTurn: plugin.prepareMiniAppTurn,
            planEntryEnabled: input.planEntryEnabled,
            normalExtensions,
            resumeSessionDeletion: (sessionId) => {
                if (!resumeSessionDeletion) {
                    throw new Error(`Session deletion recovery is not bound: ${sessionId}`);
                }
                return resumeSessionDeletion(sessionId);
            },
            disposeMcpSession: (sessionId) => mcpRuntime.disposeSession(sessionId),
            goalVerifierExtension: subagentVerification.extension,
            goalVerifierOutputTokenCap: subagentVerification.outputTokenCap,
            miniAppApprovals: miniAppAgent,
        });
        const sessionApplications = await initializeSessionApplications(input, turnSystem, plugin, (sessionId) => cron?.isSessionOwnedByDefinition(sessionId) ?? false);
        if (miniAppAgent)
            bindMiniAppAgentSessions(miniAppAgent, input, turnSystem, sessionApplications);
        cron = input.enableCron
            ? initializeRuntimeCron({
                reviewContent: input.safety.review,
                options: input.options,
                sessionPorts: {
                    agentSessionPorts: input.agentSessionPorts,
                    sessions: input.sessionSystem,
                    turns: turnSystem.turns,
                    reportFailure: input.product.executor.reportFailure,
                    lifecycle: sessionApplications.sessionApplications.session.lifecycle,
                    deletion: sessionApplications.applications.session.lifecycle,
                    resolveDefaultWorkspaceDir: input.options.compatibility.sessionV2.workspace.defaultDirectory,
                },
                config: () => input.product.preparation.configBuilder.config(),
                nowMs: input.nowMs,
            })
            : undefined;
        input.bindGoalCronOwnerReader((sessionId) => cron ? hasActiveCronSessionOwner(cron.service, sessionId) : false);
        resumeSessionDeletion = (sessionId) => sessionApplications.applications.session.lifecycle.deleteSessionById(sessionId);
        const evaluatorVerifier = createGoalEvaluatorVerifier({
            tuiProductPolicy: input.options.runtimeOwnerKind === 'tui',
            sessions: input.sessionSystem.sessions.execution,
            agents: input.product.agents,
            preparation: input.preparation,
            config: input.product.preparation.configBuilder.config,
            nowMs: input.nowMs,
        });
        input.goal.service.bindVerifier({
            dispatch: (attempt, signal) => attempt.backend === 'subagent'
                ? subagentVerification.verifier.dispatch(attempt, signal)
                : evaluatorVerifier.dispatch(attempt, signal),
        }, createGoalVerificationTranscriptReader(input.sessionSystem.canonicalHistory));
        return {
            plan,
            turnSystem,
            cron,
            plugin,
            miniAppComposition,
            miniAppAgent,
            mcp,
            skillSystem,
            agentApplication: sessionApplications.agentApplication,
            runtimeConversation: sessionApplications.runtimeConversation,
            applications: sessionApplications.applications,
            sessionApplications: sessionApplications.sessionApplications,
            memory: input.memory,
        };
    }
    catch (error) {
        input.options.compatibility.conversation.fail(error);
        await closeRuntimeServiceOwnersAfterFailure({
            cron,
            turnSystem,
            plugin,
            mcp,
            skillSystem,
            sessionSystem: input.sessionSystem,
            miniApp: miniAppComposition?.services.miniApp,
            memory: input.memory,
        });
        throw error;
    }
}
async function initializePromptBoundRuntimeServiceOwners(input) {
    return withRuntimePromptSupportRollback(input.promptSupport, async () => {
        // Compat channel owner assembly (single-production-owner rule + wire
        // validation) lives in channel-system/composition/compat-owner.ts.
        const channelSystem = buildCompatChannelSystemOwner({
            enableChannel: input.enableChannel,
            channelWire: input.options.compatibility.channelWire,
            messages: input.sessionSystem.messages.repository,
            sessions: input.sessionSystem.sessions.repository,
        });
        const queryCollapseKeys = createQueryCollapseKeyResolver({
            state: input.sessionSystem.queryCollapse.state,
            messages: input.sessionSystem.messages.repository,
            getGoalBySession: (sessionId) => input.goalPort.getBySession(sessionId),
        });
        const sessionClio = composeRuntimeSessionClio(input);
        const messageDelivery = createRuntimeMessageDelivery(input.sessionSystem, channelSystem, queryCollapseKeys, { nowMs: input.nowMs, ...(sessionClio ? { sessionClio: sessionClio.capture } : {}) });
        const turnLifecycleEvents = createSessionTurnLifecycleEvents({
            sessions: input.sessionSystem.sessions.repository,
            publish: input.writeGlobalEvent,
            terminalMemory: input.product.terminalMemory,
            captureAfterTurn: (sessionId) => input.workspaceIndexing.captureRevisionAfterTurn(sessionId),
            goals: input.goalPort,
        });
        const memory = initializeRuntimeMemoryV2System({
            ...input,
            quota: input.options.compatibility.sessionHandoff.cloud,
        });
        const owners = await initializeRuntimeServiceOwners({
            ...input,
            channelSystem,
            messageDelivery,
            turnLifecycleEvents,
            memory,
            ...(sessionClio ? { sessionClio } : {}),
        });
        sessionClio?.start();
        return { channelSystem, owners, queryCollapseKeys, sessionClio };
    });
}
function composeRuntimeSessionClio(input) {
    const clio = input.options.sessionClio;
    if (!clio)
        return undefined;
    return composeSessionClio({
        db: input.options.db,
        messages: input.sessionSystem.messages.repository,
        authContext: clio.authContext,
        gateway: clio.gateway,
        trajectoryId: clio.trajectoryId,
        enabled: clio.enabled,
        nowMs: input.nowMs,
        ...(clio.bizId ? { bizId: clio.bizId } : {}),
        ...(clio.tickIntervalMs !== undefined ? { tickIntervalMs: clio.tickIntervalMs } : {}),
        ...(input.product.executor.reportFailure
            ? { reportFailure: input.product.executor.reportFailure }
            : {}),
        ...(input.options.overrides?.sessionClio
            ? { overrides: input.options.overrides.sessionClio }
            : {}),
    });
}
async function initializeSessionApplications(input, turnSystem, plugin, isSessionOwnedByScheduledTask) {
    const sessionApplications = initializeSessionApplicationSystem({
        owner: input.sessionSystem,
        pin: input.pinService,
        canvas: input.canvas,
        compatibility: { ...input.options.compatibility.sessionV2, goals: input.goalPort },
        archiveTitleModel: input.archiveTitleModel,
        maintenance: turnSystem.maintenance,
        facts: input.facts,
        processStartedAtMs: input.processStartedAtMs,
        ...(input.product.promptSnapshots ? { promptSnapshots: input.product.promptSnapshots } : {}),
    });
    const sessionHandoff = await createSessionHandoffComposition({
        ...(input.options.metrics ? { metrics: input.options.metrics } : {}),
        dataDir: input.options.dataDir,
        compatibility: input.options.compatibility.sessionHandoff,
        ...(input.options.logger ? { logger: input.options.logger } : {}),
        sessions: input.sessionSystem.repositories.sessions,
        worktree: input.options.forkWorktree ?? unavailableForkWorktree,
        recommendation: {
            agents: input.product.agents,
            preparation: input.preparation,
            config: input.product.preparation.configBuilder.config,
        },
        ...(input.options.nowMs ? { nowMs: input.options.nowMs } : {}),
    });
    const applications = initializeApplications({
        ...bindBackgroundTaskApplications(input.options.prepared, turnSystem, input.writeGlobalEvent),
        cloudSessionReader: new CloudSessionReader(input.options.compatibility.sessionHandoff.cloud),
        sidebarAgents: { list: () => input.options.agentService.list() },
        sidebarCronTargets: () => listCronTargetSessionIds(input.options.db),
        sessionSystem: sessionApplications,
        pinService: input.pinService,
        workspaceIndexing: input.workspaceIndexing,
        compatibility: input.options.compatibility.sessionV2,
        attachmentRegistration: input.options.compatibility.attachmentRegistration,
        sessionHandoff,
        resolveAgentWriteTarget: input.agentSessionPorts.resolveWriteTarget,
        requireExactAgentKey: input.agentSessionPorts.requireExactAgentKey,
        ...createRuntimePluginSessionLifecycle(turnSystem, plugin),
        turn: turnSystem.turns,
        assertSessionDeletionAllowed: async (sessionId) => {
            if (isSessionOwnedByScheduledTask(sessionId)) {
                throw new AppError(409, 'CRON_OWNED_SESSION', 'This session is owned by a scheduled task. Delete the scheduled task instead.');
            }
        },
        conversationMutationPort: input.sessionSystem.conversationMutationState,
        conversationMutationWorkflow: createProductionConversationMutationWorkflow({
            sessionFork: input.sessionSystem.fork,
            forkState: createForkState({
                ...input.options.compatibility.sessionV2,
                plan: {
                    documents: input.sessionSystem.planDocuments,
                    modes: input.sessionSystem.sessions.interactionMode,
                },
            }),
            sessionRewind: input.sessionSystem.messages.rewind,
            rewindPreview: input.options.compatibility.sessionV2.diff.rewind,
            operations: input.sessionSystem.sessions.operationIntents,
            mutationPlanState: input.sessionSystem.conversationMutationState,
            stream: input.sessionSystem.stream,
            turn: turnSystem.turns,
            trustedEditSubmission: turnSystem.trustedEditSubmission,
            questionnaires: input.options.compatibility.questionnaires.createService(),
            worktree: input.options.forkWorktree ?? unavailableForkWorktree,
            attachmentRegistration: input.options.compatibility.attachmentRegistration,
            publishGlobalEvent: input.writeGlobalEvent,
        }),
        publishGlobalEvent: input.writeGlobalEvent,
        ...(input.options.nowMs ? { nowMs: input.options.nowMs } : {}),
        ...(input.options.metrics ? { metrics: input.options.metrics } : {}),
        ...(input.memory ? { memory: input.memory.sessionDeletion } : {}),
        onRootBestEffortFailure: (failure) => reportRootBestEffortFailure(input.product.executor.reportFailure, failure),
    });
    bindRuntimeHostedCloudHandoff({
        hosted: input.options.compatibility.sessionHandoff.hosted,
        handoff: applications.session.handoff,
        turnSystem,
        diagnostics: input.options,
    });
    const agentApplication = createRuntimeAgentApplication(input, applications);
    const runtimeConversation = composeV1Conversation({
        attachmentRegistration: input.options.compatibility.attachmentRegistration,
        rootAgents: input.agentSessionPorts.roots,
        resolveAgentWriteTarget: input.agentSessionPorts.resolveWriteTarget,
        sessions: input.sessionSystem,
        turns: turnSystem.turns,
        lifecycle: sessionApplications.session.lifecycle,
        deletion: applications.session.lifecycle,
        root: applications.session.root,
        taskOccupancy: turnSystem.subagentOccupancy,
        onQueueWakeFailure: createQueueWakeFailureReporter(input.product.executor.reportFailure, 'conversation_queue_wake_failed'),
    });
    return { sessionApplications, applications, agentApplication, runtimeConversation };
}
async function prepareRuntimeServiceComposition(creation, safety) {
    const compatibility = resolveServicesCompatibility(creation.compatibility);
    const options = {
        ...creation,
        compatibility,
        computerUsePreferences: createComputerUsePreferenceStore(creation.db),
    };
    const browserUseComposition = createRuntimeBrowserUseComposition(options);
    const prepared = options.prepared ?? prepareRuntimeServices(options);
    const nowMs = options.nowMs ?? Date.now;
    const processStartedAtMs = nowMs();
    const ownerLifecycle = createDeferredRuntimeOwnersLifecycle();
    const state = { closed: false };
    const computerUse = await restoreRuntimeComputerUsePreferences({
        client: options.computerUseClient,
        preferences: options.computerUsePreferences,
        logger: options.logger,
    });
    const sandbox = initializeRuntimeSandbox(options);
    const { bindSessionSystem, inspector } = await createRuntimeInspector(options);
    const writeGlobalEvent = createServiceGlobalEventWriter(options, state, browserUseComposition.service, sandbox);
    const turnCapabilities = new AgentHostTurnCapabilityLifecycle();
    options.overrides?.inspectTurnCapabilities?.(turnCapabilities);
    const { globalInstructions, promptSupport, productionSessionComposition, agentSessionPorts } = await createRuntimePromptSessionSupport({
        options,
        safety,
        nowMs,
        writeGlobalEvent,
        inspector,
        browserUse: browserUseComposition.service,
    });
    const agentShell = composeAgentShell({
        db: options.db,
        nowMs,
        composition: productionSessionComposition,
        bindPermissions: options.compatibility.bindPermissionShellResolver,
        sandboxOperationsFactory: options.sandboxOperationsFactory,
    });
    options.compatibility.bindQuestionnaireGoalProbe(async (sessionId) => (await productionSessionComposition.goalPort.getBySession(sessionId))?.status === 'active');
    const { promptConfig, internalTurnPromptReads } = promptSupport;
    return {
        options: { ...options, prepared },
        browserUseComposition,
        nowMs,
        processStartedAtMs,
        ownerLifecycle,
        state,
        computerUse,
        sandbox,
        bindSessionSystem,
        inspector,
        writeGlobalEvent,
        turnCapabilities,
        globalInstructions,
        promptSupport,
        productionSessionComposition,
        agentSessionPorts,
        promptConfig,
        internalTurnPromptReads,
        agentShell,
    };
}
//# sourceMappingURL=services.js.map