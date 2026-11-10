import * as ppt from './runtime-ppt-applications.js';
import { bindBackgroundTaskApplications } from './background-task-application.js';
import { CloudSessionReader } from '@mavis/agent-tools/desktop';
import {} from '../conversation/index.js';
import { bindRuntimeHostedCloudHandoff } from './runtime-services-composition.js';
// Through the application barrel, like services.ts, so composition tests can replace them.
import { AgentApplication, AppError, createRuntimeAgentApplication, createRuntimePluginSessionLifecycle, initializeApplications, ModelProviderApplication, } from '../index.js';
import { createProductionConversationMutationWorkflow, unavailableForkWorktree, } from './conversation-mutation-workflow.js';
import { createForkState } from './conversation-fork-state.js';
import {} from './turn-lifecycle-event-observer.js';
import { createQueueWakeFailureReporter, reportRootBestEffortFailure, } from './turn-message-delivery.js';
import { createSessionHandoffComposition } from '../../service/session-handoff/index.js';
import {} from '../../service/channel-system/index.js';
import {} from '../../service/content-safety/index.js';
import { listCronTargetSessionIds } from '../../service/cron/index.js';
import {} from '../../service/agent/index.js';
import {} from '../../service/llm-context-inspector/index.js';
import {} from '../../service/memory-system/index.js';
import { initializeSessionApplicationSystem, } from '../../service/session-system/index.js';
import {} from '../../service/plugin-system/index.js';
import { AgentHostTurnCapabilityLifecycle, } from '../../service/turn-system/index.js';
import { composeV1Conversation } from '../../service/v1-conversation-compat/index.js';
export async function initializeSessionApplications(input, turnSystem, plugin, ownership) {
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
    ownership.ownArchiveTitle(sessionApplications.root.archiveTitle);
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
            if (ownership.isSessionOwnedByScheduledTask(sessionId)) {
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
            ...rewindEditActiveTurn(turnSystem),
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
/** Lets Rewind/Edit refuse a Turn that another live Runtime owns. */
function rewindEditActiveTurn(turnSystem) {
    const inspection = turnSystem.inspection;
    return inspection ? { activeTurn: (sessionId) => inspection.activeTurn(sessionId) } : {};
}
//# sourceMappingURL=runtime-session-applications.js.map