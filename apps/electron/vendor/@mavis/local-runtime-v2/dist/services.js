import { initializeSessionApplications, } from './application/session/runtime-session-applications.js';
import { createWorkspaceFileSaver } from './application/memory/save-workspace-file.js';
import * as ppt from './application/session/runtime-ppt-applications.js';
import { composeAgentShell, withAgentShellPermission, } from './application/session/agent-shell-composition.js';
import { closeQuietly, composeRuntimeModelAccess, withModelAccessAuth, openRuntimeModelAccess, } from './application/session/runtime-model-access.js';
import { initializeSkillSystem } from './service/skill/index.js';
import { createComputerUseDefaultPreference, createComputerUsePreferenceStore, createComputerUsePluginCallbacks, deactivateComputerUsePlugin, restoreRuntimeComputerUsePreferences, } from './service/computer-use/index.js';
import { getRuntimeRegion, getRuntimeBuildEnv, } from '@mavis/config';
import { createQueryCollapseKeyResolver, } from './application/conversation/index.js';
import { createRuntimeMessageDelivery } from './application/conversation/runtime-message-delivery.js';
import { createRuntimeAuthRecoveryNotifier } from './application/session/runtime-execution-auth.js';
import { createRuntimeWorkspace, createRuntimeNormalExtensions, createServiceGlobalEventWriter, requirePreparedSkillState, prepareRuntimeServices, initializeRuntimeSandbox, initializeRuntimeCron, resolveServicesCompatibility, } from './application/session/runtime-services-composition.js';
import { AgentApplication, configureRuntimePluginHooks, createRuntimeServicesLifecycle, closeRuntimeOwners, bindGoalConversation, startupRecoveryControls, startupRecoveryInputs, closeRuntimeServiceOwnersAfterFailure, createRuntimeSkillApplication, createRuntimeBrowserUseComposition, createGoalEvaluatorVerifier, createGoalSubagentVerifierRuntime, ownsElectronRuntimeCapabilities, ownsScheduledRuntimeCapabilities, ModelProviderApplication, closeRuntimeTitles, sessionActivityFor, } from './application/index.js';
import { createRuntimeProcessLocalApplication, createRuntimeUserApplications, } from './application/session/runtime-user-applications.js';
import { createGoalVerificationTranscriptReader } from './application/agent/goal-verification-transcript.js';
import { createRuntimeGoalApplications, } from './application/session/goal-application.js';
import { bindTaskAgentBindingCapture } from './application/session/task-agent-ready-inventory.js';
import { createSessionTurnLifecycleEvents } from './application/session/turn-lifecycle-event-observer.js';
import { planFailureReporter } from './application/session/runtime-service-ports.js';
import { initializeRuntimeCanvas } from './service/canvas/index.js';
import { initializeRuntimeTurnSystem } from './application/session/turn-system-composition.js';
import { composeRuntimeSessionClio, } from './application/session/runtime-session-clio.js';
import { buildCompatChannelSystemOwner, } from './service/channel-system/index.js';
import { initializeManagedContentSafetyService, } from './service/content-safety/index.js';
import { createOptionalRuntimeCronTurnDelivery, hasActiveCronSessionOwner, } from './service/cron/index.js';
import { AgentFavorites, createDeferredLocalAgentRuntimePort, } from './service/agent/index.js';
import { bindRuntimeServicePromptLifecycle, withRuntimePromptSupportRollback, } from './service/prompt-config/index.js';
import { createRuntimePromptSessionSupport } from './application/session/runtime-prompt-support.js';
import { createRuntimeInspector, } from './service/llm-context-inspector/index.js';
import { initializeRuntimeMemoryV2System, } from './service/memory-system/index.js';
import { memoryDesktopApplicationFor, } from './application/memory/memory-desktop-application.js';
import { createComposerPreferences, } from './service/session-system/index.js';
import { initializePluginHookPermissions, initializePluginService, createPluginNameReservations, } from './service/plugin-system/index.js';
import { resolvePluginServiceLogger } from './application/session/plugin-service-logger.js';
import { bindMiniAppAgentSessions, createRuntimeMiniAppAgent, miniAppHostVersion, } from './application/session/miniapp-agent-wiring.js';
import { composeRuntimeMiniApp, } from './application/session/runtime-miniapp-composition.js';
import { initializeMcpServiceWithOAuth, mcpDeliveryServices, pluginMcpAuthDependencies, } from './service/mcp/index.js';
import { createDeferredRuntimeOwnersLifecycle, resolveRuntimeMiniAppOptions, } from './service/miniapp/index.js';
import { bindConversationMutationPlanState, initializePlanService, createPlanEntryReaders, } from './service/plan/index.js';
import { AgentHostTurnCapabilityLifecycle, deactivateLocalPluginHooks, disposeLocalPluginHookSessions, requireTurnSystem, } from './service/turn-system/index.js';
import { createDeferredLocalSandboxBashOperationsFactory, } from './service/sandbox/index.js';
export { bindAskUserRuntimeProbes } from './application/session/questionnaire-runtime-probes.js';
export { createRuntimeAgentComposition, } from './service/agent/index.js';
export { createDeferredLocalSandboxBashOperationsFactory, } from './service/sandbox/index.js';
/** Creates the deferred service ports required before the host binds its consumers. */
export function createRuntimeServicePorts(options) {
    return {
        agentRuntimePort: createDeferredLocalAgentRuntimePort(),
        sandboxOperationsFactory: createDeferredLocalSandboxBashOperationsFactory(options.sandboxEnabled, options.bashEnvPolicy, options.getSkipParentDeathGuard),
    };
}
export { prepareRuntimeServices, } from './application/session/runtime-services-composition.js';
/**
 * Builds SessionSystem, the Plugin service, optional Channel/Cron owner
 * capabilities, AgentHost, and TurnSystem over that graph.
 */
export async function createRuntimeServices(creation) {
    const compatibility = resolveServicesCompatibility(creation.compatibility);
    const safety = initializeManagedContentSafetyService(compatibility.safety);
    let hookPermissions;
    let modelAccess;
    try {
        modelAccess = await openRuntimeModelAccess(creation, compatibility);
        hookPermissions = initializePluginHookPermissions({
            dataDir: creation.dataDir,
            bind: compatibility.pluginHookPermissions.bind,
        });
        return await composeRuntimeServices({ ...creation, compatibility }, safety, hookPermissions, modelAccess);
    }
    catch (error) {
        await closeQuietly([
            () => modelAccess?.close(),
            () => hookPermissions?.close(),
            () => safety.close(),
        ]);
        throw error;
    }
}
async function composeRuntimeServices(creation, safety, hookPermissions, modelAccess) {
    const compatibility = resolveServicesCompatibility(creation.compatibility);
    const access = await composeRuntimeModelAccess(creation, compatibility, modelAccess);
    const { options, browserUseComposition, nowMs, processStartedAtMs, ownerLifecycle, state, computerUse, sandbox, bindSessionSystem, inspector, writeGlobalEvent, turnCapabilities, globalInstructions, promptSupport, productionSessionComposition, agentSessionPorts, promptConfig, internalTurnPromptReads, agentShell, } = await prepareRuntimeServiceComposition(creation, safety, access.resolution);
    bindSessionSystem(productionSessionComposition.sessionSystem);
    const { product: baseProduct, modelSystem, modelAccessRelistLifecycle, modelProviderApplication, sessionSystem, pinService, goal, goalPort, } = productionSessionComposition;
    // Windows-only: the first native Bash call waits for the Session shell binding, so the
    // permission gate must resolve the very same AgentShell instance that owns that binding.
    const product = withAgentShellPermission(baseProduct, agentShell);
    const { planEntryEnabled, agentPlanEntryEnabled } = createPlanEntryReaders(product.preparation.configBuilder.config);
    const canvas = initializeRuntimeCanvas(options, sessionSystem);
    const pptPreview = ppt.initializeRuntimePptPreview(options, sessionSystem, nowMs);
    const workspace = createRuntimeWorkspace(options, sessionSystem, writeGlobalEvent);
    const promptBoundOwners = await initializePromptBoundRuntimeServiceOwners({
        ...productionSessionComposition,
        options,
        processStartedAtMs,
        product,
        canvas,
        pptPreview,
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
    const { conversation, remoteMessage, skill } = createRuntimeUserApplications({
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
    const modelAccessServices = access.services(modelSystem.providers);
    const application = createRuntimeProcessLocalApplication({
        goals: goalApplications.processLocal,
        modelAccess: modelAccessServices.modelAccessApplication,
        options,
        owners,
        sessionSystem,
        skill,
        planEntryEnabled,
        modelSystem,
        modelProviderApplication,
        ...ppt.composePptApplication(options, pptPreview, productionSessionComposition, nowMs),
    });
    if (owners.cron)
        options.compatibility.cron.bindAgentCleanup(owners.cron.service);
    const cronDelivery = createOptionalRuntimeCronTurnDelivery(Boolean(owners.cron), options.overrides?.cron?.turnDelivery, owners.turnSystem.turns, product.executor.reportFailure);
    const lifecycle = createRuntimeServicesLifecycle({
        recoverPersistedState: options.recoverPersistedState,
        state,
        readyModelAccess: access.markReady,
        bindGlobalEventPublisher: () => options.compatibility.events.bindPublisher(writeGlobalEvent),
        reportFailure: options.compatibility.agentHost.executor.reportFailure,
        bindConversation: bindGoalConversation(goal, options, owners.runtimeConversation),
        ...startupRecoveryInputs(goal, options, owners.runtimeConversation),
        shutdownConversation: () => options.compatibility.conversation.shutdown(),
        disposePluginHookSessions: disposeLocalPluginHookSessions,
        closeTitles: () => closeRuntimeTitles(sessionSystem.titles, owners.sessionApplications.root.archiveTitle),
        sessionSystem,
        ...workspaceLifecycleInputs(workspace),
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
    ownerLifecycle.bind(access.lifecycle({
        promptLifecycle: ppt.withPromptLifecycle(pptPreview, promptLifecycle),
        modelAccessRelistLifecycle,
        hookPermissions,
        safety,
        replaceUnavailableDefaultModel: () => modelProviderApplication.replaceUnavailableDefaultModel(),
        writeGlobalEvent,
    }));
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
        saveWorkspaceFile: createWorkspaceFileSaver(workspace.file, owners.memory),
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
        remoteMessage,
        applications: owners.applications,
        ...sessionActivityFor({ sessionSystem, owners, application, goalPort, nowMs }),
        application,
        plugin: owners.plugin.plugin,
        ...mcpDeliveryServices(owners.mcp),
        hookConfig: pluginHooks.hookConfig,
        modelSystem,
        ...modelAccessServices,
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
        notifyRoutingContextChanged: () => access.laneChanged(),
        notifyAuthContextChanged: createRuntimeAuthRecoveryNotifier({
            mode: options.executionAuthMode,
            isClosed: () => state.closed,
            notifyPluginContextChanged: withModelAccessAuth(access, pluginHooks.notifyAuthContextChanged),
            promptConfig,
            ...authRecoveryInputs(options, owners, sessionSystem, product),
        }),
        builtinAgentDefinitionsReady: lifecycle.builtinAgentDefinitionsReady,
        ready: owners.miniAppComposition.ready,
        ...startupRecoveryControls(lifecycle, () => closeRuntimeOwners(sessionClio, owners.miniAppComposition, goal), access.revoke),
    };
}
function workspaceLifecycleInputs(workspace) {
    return {
        workspaceGit: workspace.git,
        workspaceHtmlPreview: workspace.htmlPreview,
        workspaceFile: workspace.file,
        workspaceIndexing: workspace.indexing,
    };
}
/** What signing in again resumes: questionnaires, Plans and queued Turns. */
function authRecoveryInputs(options, owners, sessionSystem, product) {
    return {
        recoverQuestionnaires: async () => {
            await options.compatibility.questionnaires.createService().recoverOnStartup();
        },
        reconcilePlan: () => owners.plan.lifecycleReconciler.schedule('auth-context-ready'),
        listPendingSessionIds: () => sessionSystem.queue.committed.listPendingSessionIds(),
        dispatchQueue: (sessionId) => owners.turnSystem.turns.dispatchQueue(sessionId),
        reportFailure: (scope, message) => product.executor.reportFailure?.(scope, message),
    };
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
async function initializeRuntimeServiceOwners(input) {
    const pluginLogger = resolvePluginServiceLogger(input.options.logger);
    const miniAppOptions = resolveRuntimeMiniAppOptions(input.options);
    const miniAppAgent = miniAppOptions ? createRuntimeMiniAppAgent(input, pluginLogger) : undefined;
    let plugin;
    let mcp;
    let skillSystem;
    let turnSystem;
    let cron;
    let archiveTitle;
    let miniAppComposition;
    let resumeSessionDeletion;
    try {
        mcp = initializeMcpServiceWithOAuth({
            ...input.options.compatibility.mcp,
            dataDir: input.options.dataDir,
            nowMs: input.nowMs,
            metrics: input.options.metrics,
            publishGlobalEvent: input.writeGlobalEvent,
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
            ...pluginMcpAuthDependencies(mcp),
            skill: skillSystem.runtime,
            listReservations: createPluginNameReservations(skillSystem.runtime, mcpRuntime),
            database: input.options.db,
            logger: pluginLogger,
        }, input.turnCapabilities, (pluginName) => {
            deactivateLocalPluginHooks(pluginName);
            deactivateComputerUsePlugin(input.options.computerUseClient, pluginName);
        });
        mcp.bindPluginAuthPort(plugin.mcpAuthPort);
        bindTaskAgentBindingCapture(input, { plugin, mcp }, pluginLogger);
        miniAppAgent?.bindPermissionSwitches(plugin.miniAppPermissionSwitches);
        miniAppComposition = await composeRuntimeMiniApp(input, {
            options: miniAppOptions,
            plugin,
            agentGateway: miniAppAgent,
            mcpRuntime,
            logger: pluginLogger,
        });
        const miniAppMemory = miniAppComposition.services.miniAppMemory;
        const normalExtensions = createRuntimeNormalExtensions({
            miniApp: {
                plugins: plugin,
                supervisor: miniAppComposition.services.miniApp,
                sessions: input.sessionSystem.sessions.repository,
                surface: input.options.compatibility.miniAppSurface,
                ...(miniAppMemory ? { memory: miniAppMemory } : {}),
                logger: pluginLogger,
            },
            pptPreview: input.options.pptPreviewRenderHost
                ? { execute: (...args) => input.pptPreview.executeNative(...args) }
                : undefined,
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
            ...(miniAppMemory ? { miniAppMemory } : {}),
        });
        const sessionApplications = await initializeSessionApplications(input, turnSystem, plugin, {
            isSessionOwnedByScheduledTask: (sessionId) => cron?.isSessionOwnedByDefinition(sessionId) ?? false,
            ownArchiveTitle: (owner) => {
                archiveTitle = owner;
            },
        });
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
        bindGoalVerifiers(input, subagentVerification.verifier);
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
            archiveTitle,
            miniApp: miniAppComposition?.services.miniApp,
            memory: input.memory,
        });
        throw error;
    }
}
/** Goal verification: subagent attempts use the subagent verifier, others the evaluator. */
function bindGoalVerifiers(input, subagent) {
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
            ? subagent.dispatch(attempt, signal)
            : evaluatorVerifier.dispatch(attempt, signal),
    }, createGoalVerificationTranscriptReader(input.sessionSystem.canonicalHistory));
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
        const sessionClio = composeRuntimeSessionClio({
            clio: input.options.sessionClio,
            db: input.options.db,
            messages: input.sessionSystem.messages.repository,
            nowMs: input.nowMs,
            reportFailure: input.product.executor.reportFailure,
            overrides: input.options.overrides?.sessionClio,
        });
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
async function prepareRuntimeServiceComposition(creation, safety, modelAccess) {
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
        modelAccess,
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