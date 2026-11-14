import { composeLocalSandboxService, } from '../../service/sandbox/index.js';
import { ownsElectronRuntimeCapabilities } from '../agent/runtime-browser-use-composition.js';
import { createMiniAppControlExtension, createPptPreviewExtension, wrapUpExtension, } from '@mavis/agent-extension';
import { isBunnyEnabledInConfig } from '@mavis/config';
import { isBunnyAgentName } from '@mavis/shared/agent-avatar';
import { schedulesTargetMainConversation } from '@mavis/shared/agent-coordination';
import { prepareBackgroundTasks, } from './background-task-composition.js';
import { createRuntimeCronSessionPorts, initializeCronService, } from '../../service/cron/index.js';
import { hasPriorityUserQueueItem, CliSunsetNotice, composeTurnAdmissionPolicies, createDesktopSubagentConcurrency, } from '../../service/turn-system/index.js';
import { createBunnyAssetReadExtension, renderScheduleSpaceLabel, } from '../../service/bunny/index.js';
import { createRuntimePtcStoreBinding, } from './runtime-ptc-store-binding.js';
import { composeRuntimeGlobalEventWriter } from '../events.js';
import { SkillEnabledState } from '../../service/plugin-system/index.js';
import { LegacyCredentialMigrationReceipt } from '../../service/channel-system/index.js';
import { ComposerSendBehaviorPreference, } from '../../service/session-system/index.js';
import { createLocalModelSystemConfigPort, resolveLocalRuntimeModelKey, } from '../../service/model-system/index.js';
import { HostedCloudHandoffCapability, } from '../../service/session-handoff/index.js';
import { initializeRuntimeWorkspaceServices, WorkspaceIndexingPolicy, } from '../../service/workspace/index.js';
import { createProductionSessionComposition, } from './runtime-session-composition.js';
import { scopeToCoordinatorSessions } from './coordinator-turn-scope.js';
import { createHostSessionMiniAppLifecycle } from './miniapp-host.js';
import { createMemoryRecallAdmissionPolicy } from './memory-recall-admission.js';
import { isPptPreviewPluginSkillEffective } from './ppt-preview-plugin-gate.js';
import { composeDesktopPluginRecommendation, } from './plugin-recommendation.js';
export function createRuntimeNormalExtensions(input) {
    const miniAppLifecycle = createHostSessionMiniAppLifecycle({
        plugins: input.plugin,
        supervisor: input.miniApp.miniApp,
        sessions: input.sessions,
        surface: input.options.compatibility.miniAppSurface,
        ...(input.miniApp.miniAppMemory ? { memory: input.miniApp.miniAppMemory } : {}),
        logger: input.logger,
    });
    const recommendation = composeDesktopPluginRecommendation({
        ...(input.options.runtimeOwnerKind ? { runtimeOwnerKind: input.options.runtimeOwnerKind } : {}),
        plugins: input.plugin.plugin,
        questionnaires: input.options.compatibility.questionnaires,
        sessions: input.sessions,
        config: input.config,
        readNativeSkill: input.readNativeSkill,
        dispatchQueue: input.dispatchQueue,
        nowMs: input.nowMs,
    });
    // Office edits use source files; the workspace owns draft conflicts and refresh.
    return {
        extensions: [
            ...(input.pptPreview
                ? [
                    createPptPreviewExtension(input.pptPreview, {
                        isAvailable: isPptPreviewPluginSkillEffective,
                    }),
                ]
                : []),
            ...(miniAppLifecycle ? [createMiniAppControlExtension(miniAppLifecycle)] : []),
            ...recommendation.extensions,
            ...(input.wrapUp ? [wrapUpExtension(input.wrapUp)] : []),
            scopeToCoordinatorSessions(createBunnyAssetReadExtension(input.bunnyAssetRead), input.bunnyAssetRead.coordinators),
        ],
        questionnaires: recommendation.questionnaires,
    };
}
export async function initializeRuntimeCron(input) {
    if (!input.options.scheduler) {
        throw new Error('Runtime Cron services require an owned Scheduler client.');
    }
    const mainConversationAgents = input.agents
        ? await readMainConversationScheduleAgents(input.agents)
        : undefined;
    return initializeCronService({
        reviewContent: input.reviewContent,
        db: input.options.db,
        scheduler: input.options.scheduler,
        ...(input.options.metrics ? { metrics: input.options.metrics } : {}),
        sessionPorts: input.options.overrides?.cron?.sessionPorts ??
            createRuntimeCronSessionPorts({
                ...input.sessionPorts,
                ...(mainConversationAgents ? { mainConversationAgents } : {}),
                // The coordinator's schedules name the task space their stored prompt points at.
                mainConversationText: (text) => renderScheduleSpaceLabel(text, () => input.sessionPorts.sessions.artifactCatalog.library.summary().spaces),
            }),
        ...(mainConversationAgents ? { mainConversationAgents } : {}),
        modelSelection: { resolve: (model) => resolveLocalRuntimeModelKey(input.config(), model) },
        nowMs: input.nowMs,
        recoverPendingRuns: input.options.recoverPersistedState !== false,
        // The Bunny beta switch pauses Bunny's routines and self-reminders without deleting them.
        isAgentPaused: (agentName) => isBunnyAgentName(agentName) && !isBunnyEnabledInConfig(input.config()),
    });
}
/**
 * Bundled built-in Agents whose schedules wake their current main
 * conversation. Only the built-in catalog can declare coordination, so a
 * Custom or Plugin Agent with the same name never gains this target.
 */
async function readMainConversationScheduleAgents(agents) {
    const names = new Set((await agents.listBuiltinDefinitions())
        .filter((definition) => schedulesTargetMainConversation(definition.coordination))
        .map((definition) => definition.name));
    return (agentName) => typeof agentName === 'string' && names.has(agentName);
}
export function bindRuntimeHostedCloudHandoff(input) {
    const { hosted, handoff, turnSystem, diagnostics } = input;
    hosted.bind({
        diagnostics,
        prepare: ({ localSessionId, dispatchId, userQuery, turnId, signal }) => handoff.prepareHostedCloudHandoffAdmission(localSessionId, dispatchId, userQuery, {
            turnId,
            signal,
            diagnostics,
            ownsTurn: () => turnSystem.inspection?.activeTurnId(localSessionId) === turnId,
        }),
        getCurrentProposal: (localSessionId) => handoff.getHostedCloudHandoffProposal(localSessionId),
        completeAnnouncement: ({ localSessionId, dispatchId }) => handoff.completeHostedCloudHandoffAnnouncement(localSessionId, dispatchId),
        failAnnouncement: ({ dispatchId, reason }) => handoff.failHostedCloudHandoffAnnouncement(dispatchId, reason),
    });
}
export function resolveServicesCompatibility(compatibility) {
    return 'create' in compatibility
        ? compatibility.create(new HostedCloudHandoffCapability())
        : compatibility;
}
export function createRuntimeAgentReferenceProjection(compatibility, agentService, logger) {
    return {
        resolveAgentReference: async (requestRef) => {
            const resolution = await compatibility.agentReferences.resolveDelegatable(requestRef);
            if (resolution !== 'authorized')
                return resolution;
            try {
                const trustedDisplayName = (await agentService.get(requestRef)).displayName.trim();
                return trustedDisplayName
                    ? { status: 'authorized', trustedDisplayName }
                    : { status: 'authorized' };
            }
            catch {
                return { status: 'authorized' };
            }
        },
        emitDiagnostic: (event) => logger.info({
            stage: event.stage,
            outcome: event.outcome,
            count: event.count,
            surface: event.surface,
            runtime: event.runtime,
            ...(event.errorCode ? { errorCode: event.errorCode } : {}),
        }, 'agent_reference'),
    };
}
export function createRuntimeWorkspace(options, sessionSystem, writeGlobalEvent) {
    return initializeRuntimeWorkspaceServices({
        ...options,
        getSession: (sessionId) => sessionSystem.repositories.sessions.get(sessionId),
    }, (payload) => writeGlobalEvent({ type: 'workspace.git.changed', payload }));
}
/**
 * The shared admission chain stays unchanged for every runtime. Trusted local
 * compositions (Desktop Electron, embedded CLI / TUI, app-server) add durable Task-child
 * concurrency policy; cloud and other hosts keep the base chain.
 */
export function createRuntimeTurnAdmissionOptions(input, planAdmission) {
    const desktopSubagentConcurrency = isTrustedLocalSubagentRuntime(input.options)
        ? createDesktopSubagentConcurrency({
            db: input.options.db,
            tasks: input.sessionSystem.sessions.taskExecutionAdmission,
            readMaxConcurrentPerSession: () => input.options.compatibility.agentHost.preparation.configBuilder.config().subagent
                ?.maxConcurrentPerSession,
            ...(input.options.logger ? { logger: input.options.logger } : {}),
        })
        : undefined;
    return {
        admissionPolicy: composeTurnAdmissionPolicies(planAdmission, createMemoryRecallAdmissionPolicy(), ...(desktopSubagentConcurrency ? [desktopSubagentConcurrency.admissionPolicy] : [])),
        ...(desktopSubagentConcurrency ? { subagentConcurrency: desktopSubagentConcurrency } : {}),
    };
}
function isTrustedLocalSubagentRuntime(input) {
    const capabilities = input.runtimeCapabilities;
    if (input.runtimeOwnerKind === 'electron')
        return capabilities?.electronHost === true;
    return ((input.runtimeOwnerKind === 'cli' ||
        input.runtimeOwnerKind === 'tui' ||
        input.runtimeOwnerKind === 'app-server') &&
        capabilities?.cliEmbedded === true);
}
export function prepareRuntimeServices(options) {
    const backgroundTasks = prepareBackgroundTasks(options);
    const workspaceIndexingPolicy = new WorkspaceIndexingPolicy(options.db);
    const skillEnabledState = new SkillEnabledState(options.db);
    const legacyCredentialMigrationReceipt = new LegacyCredentialMigrationReceipt(options.db);
    const cliSunsetNotice = new CliSunsetNotice(options.db);
    const composerSendBehavior = new ComposerSendBehaviorPreference(options.db);
    const ptcStoreBinding = createRuntimePtcStoreBinding(options.logger);
    return {
        ptcStoreBinding,
        backgroundTasks,
        workspaceIndexingPolicy,
        skillEnabledState,
        legacyCredentialMigrationReceipt,
        cliSunsetNotice,
        composerSendBehavior,
        v1: {
            createBackgroundTaskRuntime: backgroundTasks.createRuntime,
            workspaceIndexing: { isEnabled: () => workspaceIndexingPolicy.isEnabled() },
            skillEnabledState,
            runLegacyImCredentialMigration: (action) => legacyCredentialMigrationReceipt.run(action),
            cliSunsetNotice,
            composerSendBehavior: () => composerSendBehavior.get(),
        },
    };
}
export function createServiceGlobalEventWriter(options, state, browserUse, sandbox) {
    return composeRuntimeGlobalEventWriter({
        isClosed: () => state.closed,
        nowMs: options.nowMs ?? Date.now,
        notifyContextReset: (sessionId) => {
            browserUse.notifyContextReset(sessionId);
            options.ptcStoreBinding?.notifyContextReset(sessionId);
        },
        notifySessionDeleted: (sessionId) => browserUse.clearSession(sessionId),
        notifyGreetingTurnTerminal: (turnId, status) => state.agentApplication?.notifyGreetingTurnTerminal?.(turnId, status),
        observeTurn: (input) => sandbox.observeTurn(input),
        write: (event) => {
            if (event.type === 'session.finish' ||
                event.type === 'session.error' ||
                event.type === 'session.abort') {
                options.computerUseClient?.release?.(event.payload.sessionId, event.payload.turnId);
            }
            options.eventBus.write(event);
        },
    });
}
export function initializeRuntimeSandbox(options) {
    return composeLocalSandboxService({
        ...options,
        configWriter: options.compatibility.sandbox.writeConfig,
        evalReporter: options.compatibility.sandbox.eval,
        sandboxDescriptors: options.overrides?.sandbox?.descriptors,
    });
}
export function createRuntimeSessionComposition(input) {
    const { options, dependencies } = input;
    return createProductionSessionComposition({
        ...options,
        compatibility: options.compatibility.sessionV2,
        goalHost: options.compatibility.goalHost,
        refreshOfficialModels: options.compatibility.modelProvider?.refreshOfficialModels,
        modelConfig: createLocalModelSystemConfigPort(options.compatibility.agentHost.preparation.configBuilder.config),
        ...dependencies,
    });
}
export function requirePreparedSkillState(options) {
    if (!options.prepared)
        throw new Error('Runtime services must be prepared before Skill construction');
    return options.prepared.skillEnabledState;
}
/** One gate for the Next Step Box: the wrap_up tool and the lifecycle projection of its card. */
export function isNextStepBoxEnabled(input) {
    return (ownsElectronRuntimeCapabilities(input.options.runtimeOwnerKind) &&
        // Already the effective opt-in: the host's config read boundary fills the user's
        // choice, else the remote default (Apollo `prompt_suggestion`), on when absent.
        input.product.preparation.configBuilder.config().nextStepBox?.enabled === true);
}
export function createNextStepRuntimeOptions(input, 
/** Read lazily: the Turn System is composed after the extensions. */
turnInspection, 
/** Read lazily too: Cron starts after the extensions. */
isSessionOwnedByScheduledTask) {
    return {
        enabled: () => isNextStepBoxEnabled(input),
        hasPendingUserInput: async (sessionId) => (turnInspection()?.hasPendingUserSteering?.(sessionId) ?? false) ||
            hasPriorityUserQueueItem(await input.sessionSystem.queue.committed.list(sessionId)),
        availableActions: async (ctx) => {
            // Archiving stops a scheduled task's runs; only the entries that confirm first may do it.
            const session = isSessionOwnedByScheduledTask(ctx.sessionId)
                ? ['new_session']
                : ['new_session', 'archive_session'];
            try {
                const changes = await input.nextStepWorkspaceGit.getChanges(ctx.workspaceDir, 'fast');
                return changes.isGitRepo && changes.files.length > 0
                    ? ['commit', 'review_changes', ...session]
                    : session;
            }
            catch {
                return session;
            }
        },
    };
}
//# sourceMappingURL=runtime-services-composition.js.map