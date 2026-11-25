import { composeLocalSandboxService, } from '../../service/sandbox/index.js';
import { ownsElectronRuntimeCapabilities } from '../agent/runtime-browser-use-composition.js';
import { createMiniAppControlExtension, createPptPreviewExtension, wrapUpExtension, } from '@mavis/agent-extension';
import { isBunnyEnabledInConfig } from '@mavis/config';
import { composeSessionPluginExtensionAuthoring } from './plugin-extension-authoring.js';
import { isBunnyAgentName } from '@mavis/shared/agent-avatar';
import { schedulesTargetMainConversation } from '@mavis/shared/agent-coordination';
import { prepareBackgroundTasks, } from './background-task-composition.js';
import { createRuntimeCronSessionPorts, initializeCronService, } from '../../service/cron/index.js';
import { hasPriorityUserQueueItem, CliSunsetNotice, composeTurnAdmissionPolicies, createDesktopSubagentConcurrency, } from '../../service/turn-system/index.js';
import { createBunnyAssetReadExtension, createBunnyScheduleOriginStore, renderScheduleSpaceLabel, } from '../../service/bunny/index.js';
import { clearManagedSkillReceiptsOutsideHistory, logManagedSkillReceiptsCleared, ManagedSkillReceipts, } from '@mavis/shared/local-runtime-managed-skills';
import { createRuntimePtcStoreBinding, } from './runtime-ptc-store-binding.js';
import { composeRuntimeGlobalEventWriter } from '../events.js';
import { settleInBackground, SkillEnabledState } from '../../service/plugin-system/index.js';
import { resolvePluginServiceLogger } from './plugin-service-logger.js';
import { LegacyCredentialMigrationReceipt } from '../../service/channel-system/index.js';
import { ComposerSendBehaviorPreference, } from '../../service/session-system/index.js';
import { createLocalModelSystemConfigPort, resolveLocalRuntimeModelKey, } from '../../service/model-system/index.js';
import { HostedCloudHandoffCapability, } from '../../service/session-handoff/index.js';
import { initializeRuntimeWorkspaceServices, WorkspaceIndexingPolicy, } from '../../service/workspace/index.js';
import { createProductionSessionComposition, } from './runtime-session-composition.js';
import { scopeToCoordinatorSessions } from './coordinator-turn-scope.js';
import { createHostSessionMiniAppLifecycle } from './miniapp-host.js';
import { createMemoryRecallAdmissionPolicy } from './memory-recall-admission.js';
import { createWorktreeCleanedAdmissionPolicy } from './worktree-cleanup-admission.js';
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
            ...composeSessionPluginExtensionAuthoring(input.options.runtimeOwnerKind, input.pluginExtension),
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
    const scheduleOrigins = input.options.bunnyDb
        ? createBunnyScheduleOriginStore({ db: input.options.bunnyDb, nowMs: input.nowMs })
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
                ...(scheduleOrigins ? { scheduleOrigin: (cronId) => scheduleOrigins.get(cronId) } : {}),
                // The coordinator's schedules name the task space their stored prompt points at.
                mainConversationText: (text) => renderScheduleSpaceLabel(text, () => input.sessionPorts.sessions.artifactCatalog.library.summary().spaces),
            }),
        ...(mainConversationAgents ? { mainConversationAgents } : {}),
        ...(scheduleOrigins ? { scheduleOrigins } : {}),
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
        // The harness event is host-neutral; desktop labels its own runtime here.
        emitDiagnostic: (event) => logger.info({
            stage: event.stage,
            outcome: event.outcome,
            count: event.count,
            surface: event.surface,
            runtime: 'desktop',
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
        admissionPolicy: composeTurnAdmissionPolicies(planAdmission, 
        // Reject before memory recall locks anything for a Turn that cannot run.
        createWorktreeCleanedAdmissionPolicy(), createMemoryRecallAdmissionPolicy(), ...(desktopSubagentConcurrency ? [desktopSubagentConcurrency.admissionPolicy] : [])),
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
/**
 * The Runtime's one managed-Skill receipt store. The composition root creates it
 * once and hands the same instance to the AgentHost gate, the first-Turn
 * preload, the committed-compaction clear and the rewind / session-deleted
 * clears below, so no module resolves a store of its own.
 */
export function createRuntimeSkillReceipts() {
    return new ManagedSkillReceipts();
}
export function createServiceGlobalEventWriter(options, state, browserUse, sandbox) {
    const logger = resolvePluginServiceLogger(options.logger);
    return composeRuntimeGlobalEventWriter({
        isClosed: () => state.closed,
        nowMs: options.nowMs ?? Date.now,
        notifyContextReset: (sessionId) => {
            browserUse.notifyContextReset(sessionId);
            dropRewoundSkillReceipts(sessionId, state, logger);
            options.ptcStoreBinding?.notifyContextReset(sessionId);
        },
        notifySessionDeleted: (sessionId) => {
            browserUse.clearSession(sessionId);
            logManagedSkillReceiptsCleared(logger, {
                sessionId,
                reason: 'session_deleted',
                cleared: state.skillReceipts.clearSession(sessionId),
            });
        },
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
/**
 * A rewind drops the turns after a point, so the Skill bodies the model read in
 * them are gone — but a Skill preloaded into the first user message is still in
 * context, and the preload told the model not to load it again. Judging the
 * conversation by the history it now has drops exactly the receipts that history
 * no longer justifies, which is the same rule a committed compaction applies.
 *
 * Best-effort and off the publication path: the rewind already happened, so the
 * history is read after the fact and a failed read falls back to dropping every
 * receipt of the conversation.
 */
function dropRewoundSkillReceipts(sessionId, state, logger) {
    const receipts = state.skillReceipts;
    const history = state.canonicalHistory;
    if (!history) {
        logManagedSkillReceiptsCleared(logger, {
            sessionId,
            reason: 'context_reset',
            cleared: receipts.clearSession(sessionId),
        });
        return;
    }
    settleInBackground(clearRewoundSkillReceipts(receipts, sessionId, history, logger));
}
/** The surviving history is read after the fact; a failed read drops every receipt. */
async function clearRewoundSkillReceipts(receipts, sessionId, history, logger) {
    try {
        const snapshot = await history.inspectActive(sessionId);
        clearManagedSkillReceiptsOutsideHistory(receipts, {
            sessionId,
            messages: snapshot.messages,
            reason: 'context_reset',
            logger,
        });
    }
    catch {
        logManagedSkillReceiptsCleared(logger, {
            sessionId,
            reason: 'context_reset',
            cleared: receipts.clearSession(sessionId),
        });
    }
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