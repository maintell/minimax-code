import { initializeSessionApplications } from './application/session/runtime-session-applications.js';
import { createWorkspaceFileSaver } from './application/memory/save-workspace-file.js';
import * as ppt from './application/session/runtime-ppt-applications.js';
import { composeAgentShell, withAgentShellPermission, } from './application/session/agent-shell-composition.js';
import { closeQuietly, composeRuntimeModelAccess, withModelAccessAuth, openRuntimeModelAccess, } from './application/session/runtime-model-access.js';
import { initializeSkillSystem } from './service/skill/index.js';
import { createComputerUsePreferenceStore, createComputerUsePluginCallbacks, deactivateComputerUsePlugin, restoreRuntimeComputerUsePreferences, } from './service/computer-use/index.js';
import { createQueryCollapseKeyResolver } from './application/conversation/index.js';
import { createRuntimeMessageDelivery } from './application/conversation/runtime-message-delivery.js';
import { createRuntimeAuthRecoveryNotifier } from './application/session/runtime-execution-auth.js';
import { createRuntimeWorkspace, createRuntimeNormalExtensions, createServiceGlobalEventWriter, createRuntimeSkillReceipts, requirePreparedSkillState, prepareRuntimeServices, createNextStepRuntimeOptions, isNextStepBoxEnabled, initializeRuntimeSandbox, initializeRuntimeCron, resolveServicesCompatibility, } from './application/session/runtime-services-composition.js';
import { promptBoundWorkspaceInputs, workspaceLifecycleInputs, } from './application/session/runtime-workspace-inputs.js';
import { createRuntimePluginHookAuthNotifier, createRuntimePluginHookConfig, createRuntimeServicesLifecycle, closeRuntimeOwners, bindGoalConversation, startupRecoveryInputs, closeRuntimeServiceOwnersAfterFailure, createRuntimeSkillApplication, createRuntimeBrowserUseComposition, createGoalSubagentVerifierRuntime, ownsElectronRuntimeCapabilities, ownsScheduledRuntimeCapabilities, closeRuntimeTitles, sessionActivityFor, } from './application/index.js';
import { createRuntimeProcessLocalApplication, createRuntimeUserApplications, } from './application/session/runtime-user-applications.js';
import { bindGoalVerifiers } from './application/session/goal-verifier-binding.js';
import { goalApplicationsForHost } from './application/session/goal-application.js';
import { bindQuotaAutoResumeRuntime, userMessageAcceptedWithQuotaAutoResume, withQuotaAutoResumeStartupRecovery, } from './application/session/quota-auto-resume-runtime.js';
import { bindTaskAgentBindingCapture } from './application/session/task-agent-ready-inventory.js';
import { createSessionTurnLifecycleEvents } from './application/session/turn-lifecycle-event-observer.js';
import { planFailureReporter } from './application/session/runtime-service-ports.js';
import { composeRuntimeBackgroundOwners } from './application/session/runtime-background-owners.js';
import { composeRuntimeComputerUseDefaultPreference } from './application/session/runtime-computer-use-preference.js';
import { initializeRuntimeCanvas } from './service/canvas/index.js';
import { initializeRuntimeTurnSystem } from './application/session/turn-system-composition.js';
import { composeRuntimeSessionClio } from './application/session/runtime-session-clio.js';
import { buildCompatChannelSystemOwner, } from './service/channel-system/index.js';
import { initializeManagedContentSafetyService, } from './service/content-safety/index.js';
import { composeMergeRequestServices } from './application/session/merge-request-composition.js';
import { bindSessionMediaNodeBinding } from './application/session/media-node-binding-composition.js';
import { hasActiveCronSessionOwner } from './service/cron/index.js';
import { bunnyCompositionOptions, composeBunnyUnlessUnavailable, } from './application/session/bunny-availability.js';
import { bindLateBunnyOwners } from './application/session/bunny-composition.js';
import { withToolSettingsSignal } from './application/session/assignment-snapshot-product.js';
import { composeDesktopToolOwners } from './service/desktop-agent-tools/index.js';
import { bindRuntimeServicePromptLifecycle, withRuntimePromptSupportRollback, } from './service/prompt-config/index.js';
import { createRuntimePromptSessionSupport } from './application/session/runtime-prompt-support.js';
import { createRuntimeInspector } from './service/llm-context-inspector/index.js';
import { initializeRuntimeMemoryV2System } from './service/memory-system/index.js';
import { memoryDesktopApplicationFor } from './application/memory/memory-desktop-application.js';
import { createComposerPreferences, } from './service/session-system/index.js';
import { initializePluginHookPermissions, initializePluginService, createPluginNameReservations, } from './service/plugin-system/index.js';
import { resolvePluginServiceLogger } from './application/session/plugin-service-logger.js';
import { composeRuntimePluginExtension } from './application/session/plugin-extension-composition.js';
import { bindMiniAppAgentSessions, createRuntimeMiniAppAgent, miniAppHostVersion, } from './application/session/miniapp-agent-wiring.js';
import { composeRuntimeMiniApp, } from './application/session/runtime-miniapp-composition.js';
import { initializeMcpServiceWithOAuth, mcpDeliveryServices, pluginMcpAuthDependencies, } from './service/mcp/index.js';
import { createDeferredRuntimeOwnersLifecycle, resolveRuntimeMiniAppOptions, } from './service/miniapp/index.js';
import { bindConversationMutationPlanState, initializePlanService, createPlanEntryReaders, } from './service/plan/index.js';
import { AgentHostTurnCapabilityLifecycle, createMemoryContextCompactor, requireTurnSystem, } from './service/turn-system/index.js';
import {} from './application/session/runtime-service-contracts.js';
export { bindAskUserRuntimeProbes } from './application/session/questionnaire-runtime-probes.js';
/** User scheduled tasks are the only Scheduler timers that keep the host awake. */
export { CRON_SCHEDULER_HANDLER_KEY } from './service/cron/index.js';
export { createPtcDeviceCohortStore } from './service/session-system/index.js';
export { createRuntimeAgentComposition } from './service/agent/index.js';
export { createRuntimeServicePorts } from './application/session/runtime-service-ports.js';
export { prepareRuntimeServices, } from './application/session/runtime-services-composition.js';
/** Plugin management (with Bunny's tool-settings signal, spec 8.3) and the extension transport. */
function pluginFacades(owners, prefixes) {
    return {
        plugin: withToolSettingsSignal(owners.plugin.plugin, prefixes),
        pluginExtension: owners.pluginExtension.surface,
    };
}
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
    const prepared = await prepareRuntimeServiceComposition(creation, safety, access.resolution);
    const { options, browserUseComposition, nowMs, state, computerUse, sandbox, bindSessionSystem, inspector, writeGlobalEvent, globalInstructions, productionSessionComposition, agentSessionPorts, promptConfig, agentShell, quotaAutoResume, goalApplications, } = prepared;
    bindSessionSystem(productionSessionComposition.sessionSystem);
    const { preparation, modelSystem, modelProviderApplication, sessionSystem, pinService, goal, goalPort, } = productionSessionComposition;
    const { channelSystem, owners, queryCollapseKeys, sessionClio, product, canvas, pptPreview, workspace, lateBunny, planEntryEnabled, } = await initializePromptBoundOwnerGraph(prepared, safety);
    state.agentApplication = owners.agentApplication;
    // A rewind keeps the Skill bodies the surviving history still holds; only the
    // global event writer can tell which, and it reads them through this.
    state.canonicalHistory = sessionSystem.canonicalHistory;
    const bunny = composeBunnyUnlessUnavailable({
        options: bunnyCompositionOptions(options, lateBunny),
        sessionSystem,
        owners,
        product,
        preparation,
        nowMs,
        bunnyState: lateBunny.state,
        listModels: () => modelProviderApplication.list(),
    }, workspace.file, () => closeRuntimeOwners(sessionClio, owners.miniAppComposition, goal, quotaAutoResume), lateBunny.bind);
    const { services: userApplications, launchpad } = createRuntimeUserApplications({
        publish: writeGlobalEvent,
        miniAppIdeaModel: { agents: product.agents, preparation },
        options,
        owners,
        goalPort,
        sessionSystem,
        queryCollapseKeys,
        workspaceIndexing: workspace.indexing,
        agentSessionPorts,
        nowMs,
        createSkillApplication: createRuntimeSkillApplication,
        noteUserMessageAccepted: userMessageAcceptedWithQuotaAutoResume(quotaAutoResume),
    });
    const modelAccessServices = access.services(modelSystem.providers);
    const application = createRuntimeProcessLocalApplication({
        goals: goalApplications.processLocal,
        modelAccess: modelAccessServices.modelAccessApplication,
        options,
        owners,
        sessionSystem,
        skill: userApplications.skill,
        planEntryEnabled,
        bunnyFeedback: bunny.services.bunnyFeedback,
        modelSystem,
        modelProviderApplication,
        ...ppt.composePptApplication(options, pptPreview, productionSessionComposition, nowMs),
    });
    const background = composeRuntimeBackgroundOwners(options, owners, product, productionSessionComposition);
    const { lifecycle } = bindRuntimeServiceLifecycles({
        prepared,
        owners,
        workspace,
        bunny,
        access,
        pptPreview,
        hookPermissions,
        safety,
        worktreeCleanup: background.worktreeCleanup,
        closeLaunchpad: () => launchpad.close(),
    });
    bindSessionMediaNodeBinding({
        events: options.eventBus,
        applications: owners.sessionApplications,
        sessions: sessionSystem.sessions.repository,
        logger: resolvePluginServiceLogger(options.logger),
    });
    return {
        agentShell,
        ...composeMergeRequestServices(prepared),
        ...bunny.services,
        agent: owners.agentApplication,
        resolveDefaultWorkspaceDir: () => options.compatibility.sessionV2.workspace.defaultDirectory(),
        safety,
        canvas,
        cron: owners.cron?.service,
        ...background,
        globalEvents: { subscribe: (subscriber) => options.eventBus.subscribe(subscriber) },
        managedWorktrees: options.compatibility.managedWorktrees,
        workspace,
        saveWorkspaceFile: createWorkspaceFileSaver(workspace.file, owners.memory),
        sessionSystem,
        pinService,
        globalInstructions,
        ...composeDesktopToolOwners({ prepared, owners, compatibility, application, safety }),
        ...(quotaAutoResume ? { quotaAutoResume } : {}),
        ...createComposerPreferences(options.db),
        ...(channelSystem ? { channelSystem } : {}),
        turnSystem: owners.turnSystem,
        browserUse: browserUseComposition.service,
        processLifecycle: owners.turnSystem.processLifecycle,
        ...userApplications,
        applications: owners.applications,
        ...sessionActivityFor({ sessionSystem, owners, application, goalPort, nowMs }),
        application,
        ...pluginFacades(owners, lateBunny.state.prefixes),
        ...mcpDeliveryServices(owners.mcp),
        hookConfig: owners.hookConfig,
        modelSystem,
        ...modelAccessServices,
        modelProviderApplication,
        skillEvolve: owners.skillSystem.evolve,
        ...computerUse,
        computerUseDefaultPreference: composeRuntimeComputerUseDefaultPreference(options),
        sandbox,
        ...(inspector ? { llmContextInspector: inspector.service } : {}),
        goal: goalApplications.http,
        ...memoryDesktopApplicationFor(owners.memory),
        ...owners.miniAppComposition.services,
        notifyRoutingContextChanged: () => access.laneChanged(),
        notifyAuthContextChanged: createRuntimeAuthRecoveryNotifier({
            mode: options.executionAuthMode,
            isClosed: () => state.closed,
            notifyPluginContextChanged: pluginHookAuthNotifier(access, owners),
            promptConfig,
            ...authRecoveryInputs(options, owners, sessionSystem, product),
        }),
        builtinAgentDefinitionsReady: lifecycle.builtinAgentDefinitionsReady,
        ready: bunny.ready,
        ...bunny.recovery(lifecycle, access.revoke),
    };
}
/**
 * The prompt-bound owner graph, plus every value derived only to build it.
 *
 * Split out of `composeRuntimeServices` so that function stays inside the
 * 200-line budget. Both inputs are already grouped, so nothing the caller holds
 * has to be re-passed by hand; the derived values come back out because the
 * service surface and the lifecycle binding read them too.
 */
async function initializePromptBoundOwnerGraph(prepared, safety) {
    const { options, nowMs, processStartedAtMs, ownerLifecycle, state, writeGlobalEvent, turnCapabilities, promptSupport, productionSessionComposition, agentSessionPorts, internalTurnPromptReads, agentShell, quotaAutoResume, inspector, } = prepared;
    const { product: baseProduct, sessionSystem } = productionSessionComposition;
    // Windows Bash permissions must use the AgentShell that owns the Session binding.
    const product = withAgentShellPermission(baseProduct, agentShell);
    const { planEntryEnabled, agentPlanEntryEnabled } = createPlanEntryReaders(product.preparation.configBuilder.config);
    const canvas = initializeRuntimeCanvas(options, sessionSystem);
    const pptPreview = ppt.initializeRuntimePptPreview(options, sessionSystem, nowMs);
    const workspace = createRuntimeWorkspace(options, sessionSystem, writeGlobalEvent);
    const lateBunny = bindLateBunnyOwners(sessionSystem.coordinatorOwnership, {
        metrics: options.metrics,
        nowMs,
        trajectory: product.runner?.evalReporterFactory,
    });
    const { channelSystem, owners, queryCollapseKeys, sessionClio } = await initializePromptBoundRuntimeServiceOwners({
        ...lateBunny.ports,
        ...productionSessionComposition,
        options,
        skillReceipts: state.skillReceipts,
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
        quotaAutoResume,
        runtimeOwnerIdentity: options.runtimeOwnerIdentity,
        planEntryEnabled,
        agentPlanEntryEnabled,
        inspector,
        promptSupport,
        enableChannel: ownsElectronRuntimeCapabilities(options.runtimeOwnerKind),
        ...promptBoundWorkspaceInputs(workspace),
        readyOwners: ownerLifecycle.ready,
        closeOwners: ownerLifecycle.close,
    });
    return {
        channelSystem,
        owners,
        queryCollapseKeys,
        sessionClio,
        product,
        canvas,
        pptPreview,
        workspace,
        lateBunny,
        planEntryEnabled,
        agentPlanEntryEnabled,
    };
}
function bindRuntimeServiceLifecycles({ prepared, owners, workspace, bunny, access, pptPreview, hookPermissions, safety, worktreeCleanup, closeLaunchpad, }) {
    const { options, state, writeGlobalEvent, sandbox, browserUseComposition, promptSupport, ownerLifecycle, productionSessionComposition, quotaAutoResume, } = prepared;
    const { goal, sessionSystem, modelAccessRelistLifecycle, modelProviderApplication } = productionSessionComposition;
    const lifecycle = createRuntimeServicesLifecycle({
        recoverPersistedState: options.recoverPersistedState,
        ...(worktreeCleanup ? { worktreeCleanup } : {}),
        state,
        readyModelAccess: access.markReady,
        bindGlobalEventPublisher: () => options.compatibility.events.bindPublisher(writeGlobalEvent),
        reportFailure: options.compatibility.agentHost.executor.reportFailure,
        bindConversation: bindGoalConversation(goal, options, owners.runtimeConversation),
        ...withQuotaAutoResumeStartupRecovery(quotaAutoResume, startupRecoveryInputs(goal, options, owners.runtimeConversation)),
        recoverAssignments: bunny.recoverAssignments,
        shutdownConversation: () => options.compatibility.conversation.shutdown(),
        closeHarness: async () => owners.turnSystem.closeHarness?.(),
        closeTitles: () => closeRuntimeTitles(sessionSystem.titles, owners.sessionApplications.root.archiveTitle),
        sessionSystem,
        ...workspaceLifecycleInputs(workspace),
        sandbox,
        closeBrowserUse: browserUseComposition.close,
        closeLaunchpad,
        ...owners,
    });
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
    return { lifecycle };
}
/** What signing in again resumes: questionnaires, Plans and queued Turns. */
/** 模型访问租约先刷新鉴权，再通知 Plugin Hook。 */
function pluginHookAuthNotifier(access, owners) {
    return withModelAccessAuth(access, createRuntimePluginHookAuthNotifier(owners));
}
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
/**
 * The Plan service and the conversation-mutation fence it owns.
 *
 * Split out of `initializeRuntimeServiceOwners`, which both sides of the
 * preview_train merge left just under the 200-line cap (197 and 199 lines), so
 * their union crossed it. The Turn System is read through a getter because Plan's
 * receipts and queue dispatch resolve it lazily, after the Turn System exists.
 */
function initializeRuntimePlanOwner(input, normalComposition, readTurnSystem) {
    const plan = initializePlanService({
        db: input.options.db,
        modes: input.sessionSystem.sessions.interactionMode,
        documents: input.sessionSystem.planDocuments,
        // Plan binds the shared owned-action slot; Plugin preparation rows route to their owner.
        questionnaires: normalComposition.questionnaires,
        queue: input.sessionSystem.queue.committed,
        receipts: {
            findReceipt: (turnId) => requireTurnSystem(readTurnSystem()).receipts.findReceipt(turnId),
        },
        dispatchQueue: (sessionId) => requireTurnSystem(readTurnSystem()).turns.dispatchQueue(sessionId),
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
    return plan;
}
/** The skill system over the prepared enabled state, reading MCP server names from the runtime. */
function initializeRuntimeSkillSystem(input, mcpRuntime) {
    return initializeSkillSystem({
        ...input.options.compatibility.skillRuntime,
        management: {
            ...input.options.compatibility.skillRuntime.management,
            reviewContent: input.safety.review,
        },
        enabledState: requirePreparedSkillState(input.options),
        readMcpServerNames: () => mcpRuntime.readConfiguredServerNames(),
    });
}
async function initializeRuntimeServiceOwners(input) {
    const pluginLogger = resolvePluginServiceLogger(input.options.logger);
    const miniAppOptions = resolveRuntimeMiniAppOptions(input.options);
    const miniAppAgent = miniAppOptions ? createRuntimeMiniAppAgent(input, pluginLogger) : undefined;
    let plugin;
    let pluginExtension;
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
        skillSystem = initializeRuntimeSkillSystem(input, mcpRuntime);
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
            turnSystem?.pluginHooks?.deactivatePlugin(pluginName);
            deactivateComputerUsePlugin(input.options.computerUseClient, pluginName);
        });
        const pluginHooks = createRuntimePluginHookConfig(input, plugin, () => turnSystem);
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
        pluginExtension = composeRuntimePluginExtension(input, plugin, mcpRuntime);
        const miniAppMemory = miniAppComposition.services.miniAppMemory;
        const normalComposition = createRuntimeNormalExtensions({
            wrapUp: createNextStepRuntimeOptions(input, () => turnSystem?.inspection, (sessionId) => cron?.isSessionOwnedByDefinition(sessionId) ?? false),
            bunnyAssetRead: {
                db: input.options.db,
                dataDir: input.options.dataDir,
                coordinators: input.sessionSystem.coordinatorOwnership,
            },
            options: input.options,
            sessions: input.sessionSystem.sessions.repository,
            config: input.product.preparation.configBuilder.config,
            nowMs: input.nowMs,
            plugin,
            miniApp: miniAppComposition.services,
            pptPreview: input.options.pptPreviewRenderHost
                ? { execute: (...args) => input.pptPreview.executeNative(...args) }
                : undefined,
            pluginExtension,
            readNativeSkill: skillSystem.runtime.readNativeSkill,
            logger: pluginLogger,
            dispatchQueue: (sessionId) => requireTurnSystem(turnSystem).turns.dispatchQueue(sessionId),
        });
        const plan = initializeRuntimePlanOwner(input, normalComposition, () => turnSystem);
        const subagentVerification = createGoalSubagentVerifierRuntime({
            createExecution: (registry) => input.goal.createVerifierExecution(registry),
            config: input.product.preparation.configBuilder.config,
            nowMs: input.nowMs,
        });
        turnSystem = await initializeRuntimeTurnSystem(input, {
            plan,
            prepareMiniAppTurn: plugin.prepareMiniAppTurn,
            planEntryEnabled: input.planEntryEnabled,
            normalExtensions: normalComposition.extensions,
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
            pluginHooks: pluginHooks.harness,
            extensionObserver: pluginExtension.turnObserver,
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
            ? await initializeRuntimeCron({
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
                agents: input.agentService,
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
            pluginExtension,
            miniAppComposition,
            miniAppAgent,
            mcp,
            skillSystem,
            agentApplication: sessionApplications.agentApplication,
            runtimeConversation: sessionApplications.runtimeConversation,
            applications: sessionApplications.applications,
            sessionApplications: sessionApplications.sessionApplications,
            memory: input.memory,
            hookConfig: pluginHooks.hookConfig,
        };
    }
    catch (error) {
        input.options.compatibility.conversation.fail(error);
        await pluginExtension?.close();
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
            nextStepEnabled: () => isNextStepBoxEnabled(input),
            terminal: input.bunnyTurnSilence,
        });
        const memory = initializeRuntimeMemoryV2System({
            ...input,
            createContextCompactor: createMemoryContextCompactor,
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
        bindQuotaAutoResumeRuntime(input.quotaAutoResume, {
            sessionSystem: input.sessionSystem,
            goalPort: input.goalPort,
            turnSystem: owners.turnSystem,
            queryKeyForContinuation: (sessionId, turnId) => queryCollapseKeys.queryKeyForContinuation(sessionId, turnId),
            // An ordinary conversation with no Session selection runs this model, so
            // the auto-resume owner can still tell a built-in account model from BYOK.
            defaultModel: () => input.product.preparation.configBuilder.config().defaultModel,
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
        bunnyDb: creation.bunnyStore.db,
        computerUsePreferences: createComputerUsePreferenceStore(creation.db),
    };
    const browserUseComposition = createRuntimeBrowserUseComposition(options);
    const prepared = options.prepared ?? prepareRuntimeServices(options);
    const nowMs = options.nowMs ?? Date.now;
    const processStartedAtMs = nowMs();
    const ownerLifecycle = createDeferredRuntimeOwnersLifecycle();
    const state = {
        closed: false,
        skillReceipts: createRuntimeSkillReceipts(),
    };
    const computerUse = await restoreRuntimeComputerUsePreferences({
        client: options.computerUseClient,
        preferences: options.computerUsePreferences,
        logger: resolvePluginServiceLogger(options.logger),
    });
    const sandbox = initializeRuntimeSandbox(options);
    const { bindSessionSystem, inspector } = await createRuntimeInspector(options);
    const writeGlobalEvent = createServiceGlobalEventWriter({ ...options, ptcStoreBinding: prepared.ptcStoreBinding }, state, browserUseComposition.service, sandbox);
    const turnCapabilities = new AgentHostTurnCapabilityLifecycle();
    options.overrides?.inspectTurnCapabilities?.(turnCapabilities);
    const { globalInstructions, promptSupport, productionSessionComposition, agentSessionPorts, quotaAutoResume, } = await createRuntimePromptSessionSupport({
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
    const goalApplications = goalApplicationsForHost(productionSessionComposition.goal.service, options.compatibility.goalHost);
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
        quotaAutoResume,
        goalApplications,
    };
}
//# sourceMappingURL=services.js.map