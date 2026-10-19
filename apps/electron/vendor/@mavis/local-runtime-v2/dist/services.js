import { initializeSkillSystem } from './service/skill/index.js';
import { createComputerUsePreferenceStore, createComputerUsePluginCallbacks, deactivateComputerUsePlugin, restoreRuntimeComputerUsePreferences, } from './service/computer-use/index.js';
import { CloudSessionReader } from '@mavis/agent-tools/desktop';
import { createQueryCollapseKeyResolver, } from './application/conversation/index.js';
import { createRuntimeMessageDelivery } from './application/conversation/runtime-message-delivery.js';
import { createRuntimeNormalExtensions, createServiceGlobalEventWriter, bindRuntimeHostedCloudHandoff, requirePreparedSkillState, prepareRuntimeServices, createServiceWorkspace, initializeRuntimeSandbox, initializeRuntimeCron, resolveServicesCompatibility, } from './application/session/runtime-services-composition.js';
import { AgentApplication, AppError, createRuntimeAgentApplication, configureRuntimePluginHooks, createRuntimePluginSessionLifecycle, createRuntimeServicesLifecycle, closeRuntimeServiceOwnersAfterFailure, createRuntimeSkillApplication, createRuntimeBrowserUseComposition, createGoalEvaluatorVerifier, createGoalSubagentVerifierRuntime, initializeApplications, ownsElectronRuntimeCapabilities, ModelProviderApplication, } from './application/index.js';
import { createRuntimeUserApplications } from './application/session/runtime-user-applications.js';
import { createGoalVerificationTranscriptReader } from './application/agent/goal-verification-transcript.js';
import { composeProcessLocalApplication } from './application/session/process-local-composition.js';
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
import {} from './service/workspace/index.js';
import { createOptionalRuntimeCronTurnDelivery, hasActiveCronSessionOwner, listCronTargetSessionIds, } from './service/cron/index.js';
import { AgentFavorites } from './service/agent/index.js';
import { bindRuntimeServicePromptLifecycle, createRuntimePromptAuthNotifier, withRuntimePromptSupportRollback, } from './service/prompt-config/index.js';
import { createRuntimePromptSessionSupport } from './application/session/runtime-prompt-support.js';
import { createRuntimeInspector, } from './service/llm-context-inspector/index.js';
import { initializeRuntimeMemoryV2System, } from './service/memory-system/index.js';
import { memoryDesktopApplicationFor, } from './application/memory/memory-desktop-application.js';
import { initializeSessionApplicationSystem, createComposerPreferences, } from './service/session-system/index.js';
import { initializePluginHookPermissions, initializePluginService, createPluginNameReservations, } from './service/plugin-system/index.js';
import { resolvePluginServiceLogger } from './application/session/plugin-service-logger.js';
import { initializeMcpService, } from './service/mcp/index.js';
import { composeMiniAppRuntimeCapability, createDeferredRuntimeOwnersLifecycle, resolveRuntimeMiniAppOptions, } from './service/miniapp/index.js';
import { bindConversationMutationPlanState, initializePlanService, createPlanEntryReaders, } from './service/plan/index.js';
import { ModelFavoritesPreference } from './service/model-system/index.js';
import { AgentHostTurnCapabilityLifecycle, deactivateLocalPluginHooks, disposeLocalPluginHookSessions, readLocalInstructionSources, requireTurnSystem, } from './service/turn-system/index.js';
import { composeV1Conversation } from './service/v1-conversation-compat/index.js';
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
    const { options, browserUseComposition, nowMs, processStartedAtMs, ownerLifecycle, state, computerUse, sandbox, bindSessionSystem, inspector, writeGlobalEvent, workspace, turnCapabilities, globalInstructions, promptSupport, productionSessionComposition, agentSessionPorts, promptConfig, internalTurnPromptReads, } = await prepareRuntimeServiceComposition(creation, safety);
    bindSessionSystem(productionSessionComposition.sessionSystem);
    const { product, preparation, modelSystem, modelProviderApplication, sessionSystem, pinService, archiveTitleModel, facts, channelTurnAdmission, } = productionSessionComposition;
    const { planEntryEnabled, agentPlanEntryEnabled } = createPlanEntryReaders(product.preparation.configBuilder.config);
    const canvas = initializeRuntimeCanvas(options, sessionSystem);
    const promptBoundOwners = await initializePromptBoundRuntimeServiceOwners({
        options,
        processStartedAtMs,
        product,
        preparation,
        sessionSystem,
        pinService,
        canvas,
        archiveTitleModel,
        facts,
        channelTurnAdmission,
        safety,
        turnCapabilities,
        agentSessionPorts,
        agentService: options.agentService,
        internalTurnPromptReads,
        writeGlobalEvent,
        nowMs,
        enableCron: ownsElectronRuntimeCapabilities(options.runtimeOwnerKind),
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
        sessionSystem,
        queryCollapseKeys,
        workspaceIndexing: workspace.indexing,
        agentSessionPorts,
        nowMs,
        createSkillApplication: createRuntimeSkillApplication,
    });
    const application = composeProcessLocalApplication({
        eventBus: options.eventBus,
        usageCommits: sessionSystem.usage.commits,
        compatibility: options.compatibility,
        listRuntimeSkills: (request) => skill.listRuntimeSkills(request),
        listSkills: owners.skillSystem.management.listSkills,
        plugins: owners.plugin.plugin,
        pluginControl: owners.plugin,
        miniApp: owners.miniAppComposition.services.miniApp,
        planEntryEnabled,
        sessionReports: sessionSystem.reporting,
        instructions: {
            listSources: (input) => readLocalInstructionSources({ ...input, dataDir: options.dataDir }),
        },
        mcp: owners.mcp.public,
        modelProvider: {
            application: modelProviderApplication,
            providers: modelSystem.providers,
            listProviderPresets: modelSystem.listProviderPresets,
            oauth: modelSystem.oauth,
            favorites: new ModelFavoritesPreference(options.db),
        },
    });
    if (owners.cron)
        options.compatibility.cron.bindAgentCleanup(owners.cron.service);
    const cronDelivery = createOptionalRuntimeCronTurnDelivery(Boolean(owners.cron), options.overrides?.cron?.turnDelivery, owners.turnSystem.turns, product.executor.reportFailure);
    const lifecycle = createRuntimeServicesLifecycle({
        recoverPersistedState: options.recoverPersistedState,
        state,
        bindGlobalEventPublisher: () => options.compatibility.events.bindPublisher(writeGlobalEvent),
        reportFailure: options.compatibility.agentHost.executor.reportFailure,
        bindConversation: () => options.compatibility.conversation.bind(owners.runtimeConversation),
        recoverQuestionnaires: async () => void (await options.compatibility.questionnaires.createService().recoverOnStartup()),
        shutdownConversation: () => options.compatibility.conversation.shutdown(),
        disposePluginHookSessions: disposeLocalPluginHookSessions,
        sessionSystem,
        workspaceGit: workspace.git,
        workspaceHtmlPreview: workspace.htmlPreview,
        sandbox,
        closeBrowserUse: browserUseComposition.close,
        ...owners,
    });
    const notifyAuthContextChanged = configureRuntimePluginHooks({
        ...options,
        plugin: owners.plugin,
        turnSystem: owners.turnSystem,
    });
    const promptLifecycle = bindRuntimeServicePromptLifecycle({
        compatibility: options.compatibility,
        support: promptSupport,
        lifecycle,
    });
    ownerLifecycle.bind({
        ready: promptLifecycle.ready,
        close: async () => {
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
        },
    });
    return {
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
        conversation,
        applications: owners.applications,
        application,
        plugin: owners.plugin.plugin,
        mcp: owners.mcp.service,
        mcpRuntime: owners.mcp.runtime,
        modelSystem,
        modelProviderApplication,
        skill,
        skillEvolve: owners.skillSystem.evolve,
        ...computerUse,
        sandbox,
        ...(inspector ? { llmContextInspector: inspector.service } : {}),
        ...memoryDesktopApplicationFor(owners.memory),
        ...owners.miniAppComposition.services,
        notifyAuthContextChanged: createRuntimePromptAuthNotifier(notifyAuthContextChanged, promptConfig),
        builtinAgentDefinitionsReady: lifecycle.builtinAgentDefinitionsReady,
        ready: owners.miniAppComposition.ready,
        close: () => closeRuntimeOwners(sessionClio, owners.miniAppComposition),
    };
}
function closeRuntimeOwners(sessionClio, miniApp) {
    sessionClio?.close();
    return miniApp.close();
}
async function initializeRuntimeServiceOwners(input) {
    const pluginLogger = resolvePluginServiceLogger(input.options.logger);
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
        miniAppComposition = await composeMiniAppRuntimeCapability({
            options: resolveRuntimeMiniAppOptions(input.options),
            db: input.options.db,
            dataDir: input.options.dataDir,
            nowMs: input.nowMs,
            plugin,
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
            wordEditor: input.options.wordEditor,
            excelEditor: input.options.excelEditor,
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
            reportFailure: (error) => {
                input.product.executor.reportFailure?.('plan-lifecycle', `owner=plan;stage=lifecycle-reconcile;error=${describeError(error)}`);
            },
            nowMs: input.nowMs,
        });
        bindConversationMutationPlanState({
            mutationState: input.sessionSystem.conversationMutationState,
            modes: input.sessionSystem.sessions.interactionMode,
            lifecycleFence: plan.lifecycleFence,
        });
        const subagentVerification = createGoalSubagentVerifierRuntime({
            createExecution: (registry) => input.options.compatibility.sessionV2.goals.createSubagentExecution?.(registry),
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
        });
        const sessionApplications = await initializeSessionApplications(input, turnSystem, plugin, (sessionId) => cron?.isSessionOwnedByDefinition(sessionId) ?? false);
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
        input.options.compatibility.sessionV2.goals.bindAutomationOwnerConflictReader?.((sessionId) => cron ? hasActiveCronSessionOwner(cron.service, sessionId) : false);
        resumeSessionDeletion = (sessionId) => sessionApplications.applications.session.lifecycle.deleteSessionById(sessionId);
        const evaluatorVerifier = createGoalEvaluatorVerifier({
            tuiProductPolicy: input.options.runtimeOwnerKind === 'tui',
            sessions: input.sessionSystem.sessions.execution,
            agents: input.product.agents,
            preparation: input.preparation,
            config: input.product.preparation.configBuilder.config,
            nowMs: input.nowMs,
        });
        input.options.compatibility.sessionV2.goals.bindVerifier?.({
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
            getGoalBySession: input.options.compatibility.sessionV2.goals.getBySession,
        });
        const sessionClio = composeRuntimeSessionClio(input);
        const messageDelivery = createRuntimeMessageDelivery(input.sessionSystem, channelSystem, queryCollapseKeys, { nowMs: input.nowMs, ...(sessionClio ? { sessionClio: sessionClio.capture } : {}) });
        const turnLifecycleEvents = createSessionTurnLifecycleEvents(input.sessionSystem.sessions.repository, input.writeGlobalEvent, input.product.terminalMemory, (sessionId) => input.workspaceIndexing.captureRevisionAfterTurn(sessionId));
        const memory = initializeRuntimeMemoryV2System(input);
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
        compatibility: input.options.compatibility.sessionV2,
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
    const workspace = createServiceWorkspace(prepared, options.compatibility, writeGlobalEvent);
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
        workspace,
        turnCapabilities,
        globalInstructions,
        promptSupport,
        productionSessionComposition,
        agentSessionPorts,
        promptConfig,
        internalTurnPromptReads,
    };
}
//# sourceMappingURL=services.js.map