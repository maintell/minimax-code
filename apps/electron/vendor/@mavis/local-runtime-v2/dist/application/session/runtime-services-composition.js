import { createMiniAppControlExtension, createWordEditorExtension, createExcelEditorExtension, } from '@mavis/agent-extension';
import { createRuntimeCronSessionPorts, initializeCronService, } from '../../service/cron/index.js';
import { composeTurnAdmissionPolicies, createDesktopSubagentConcurrency, } from '../../service/turn-system/index.js';
import { composeLocalSandboxService, } from '../../service/sandbox/index.js';
import { composeRuntimeGlobalEventWriter } from '../events.js';
import { SkillEnabledState } from '../../service/plugin-system/index.js';
import { LegacyCredentialMigrationReceipt } from '../../service/channel-system/index.js';
import { CliSunsetNotice } from '../../service/turn-system/index.js';
import { ComposerSendBehaviorPreference, } from '../../service/session-system/index.js';
import { createLocalModelSystemConfigPort, resolveLocalRuntimeModelKey, } from '../../service/model-system/index.js';
import { HostedCloudHandoffCapability, } from '../../service/session-handoff/index.js';
import { initializeWorkspaceSystem, WorkspaceIndexingPolicy, } from '../../service/workspace/index.js';
import { createProductionSessionComposition, } from './runtime-session-composition.js';
import { createHostSessionMiniAppLifecycle } from './miniapp-host.js';
import { createMemoryRecallAdmissionPolicy } from './memory-recall-admission.js';
export function createRuntimeNormalExtensions(input) {
    const miniAppLifecycle = createHostSessionMiniAppLifecycle(input.miniApp);
    return [
        ...(miniAppLifecycle ? [createMiniAppControlExtension(miniAppLifecycle)] : []),
        ...(input.excelEditor ? [createExcelEditorExtension(input.excelEditor)] : []),
        ...(input.wordEditor ? [createWordEditorExtension(input.wordEditor)] : []),
    ];
}
export function initializeRuntimeCron(input) {
    if (!input.options.scheduler) {
        throw new Error('Runtime Cron services require an owned Scheduler client.');
    }
    return initializeCronService({
        reviewContent: input.reviewContent,
        db: input.options.db,
        scheduler: input.options.scheduler,
        ...(input.options.metrics ? { metrics: input.options.metrics } : {}),
        sessionPorts: input.options.overrides?.cron?.sessionPorts ??
            createRuntimeCronSessionPorts(input.sessionPorts),
        modelSelection: { resolve: (model) => resolveLocalRuntimeModelKey(input.config(), model) },
        nowMs: input.nowMs,
        recoverPendingRuns: input.options.recoverPersistedState !== false,
    });
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
export function createServiceWorkspace(prepared, compatibility, writeGlobalEvent) {
    return initializeWorkspaceSystem({
        git: {
            publishChanged: (payload) => writeGlobalEvent({ type: 'workspace.git.changed', payload }),
        },
        indexingPolicy: prepared.workspaceIndexingPolicy,
        indexingExecutor: compatibility.workspace,
    });
}
/**
 * The shared admission chain stays unchanged for every runtime. Only the
 * trusted Electron composition adds durable Task-child concurrency policy.
 */
export function createRuntimeTurnAdmissionOptions(input, planAdmission) {
    const desktopSubagentConcurrency = isTrustedDesktopSubagentRuntime(input.options)
        ? createDesktopSubagentConcurrency({
            db: input.options.db,
            tasks: input.sessionSystem.sessions.taskExecutionAdmission,
            maxConcurrentPerSession: input.options.compatibility.agentHost.preparation.configBuilder.config().subagent
                ?.maxConcurrentPerSession,
        })
        : undefined;
    return {
        admissionPolicy: composeTurnAdmissionPolicies(planAdmission, createMemoryRecallAdmissionPolicy(), ...(desktopSubagentConcurrency ? [desktopSubagentConcurrency.admissionPolicy] : [])),
        ...(desktopSubagentConcurrency ? { subagentConcurrency: desktopSubagentConcurrency } : {}),
    };
}
function isTrustedDesktopSubagentRuntime(input) {
    return input.runtimeOwnerKind === 'electron' && input.runtimeCapabilities?.electronHost === true;
}
export function prepareRuntimeServices(options) {
    const workspaceIndexingPolicy = new WorkspaceIndexingPolicy(options.db);
    const skillEnabledState = new SkillEnabledState(options.db);
    const legacyCredentialMigrationReceipt = new LegacyCredentialMigrationReceipt(options.db);
    const cliSunsetNotice = new CliSunsetNotice(options.db);
    const composerSendBehavior = new ComposerSendBehaviorPreference(options.db);
    return {
        workspaceIndexingPolicy,
        skillEnabledState,
        legacyCredentialMigrationReceipt,
        cliSunsetNotice,
        composerSendBehavior,
        v1: {
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
        notifyContextReset: (sessionId) => browserUse.notifyContextReset(sessionId),
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
//# sourceMappingURL=runtime-services-composition.js.map