import { ModelFavoritesPreference } from '../../service/model-system/index.js';
import { composeProcessLocalApplication } from './process-local-composition.js';
import { readLocalInstructionSources } from '../../service/turn-system/index.js';
import { createRuntimeConversationApplication } from '../conversation/runtime-conversation-application.js';
import { UndeliveredSideMessages, } from '../conversation/undelivered-side-messages.js';
/** Undelivered side messages over the Session's message rows, stream and Goal owner. */
export function createRuntimeUndeliveredSideMessages(input) {
    return new UndeliveredSideMessages({
        messages: input.sessionSystem.messages.repository,
        stream: input.sessionSystem.stream,
        goals: input.goalPort,
        ...(input.reportFailure ? { reportFailure: input.reportFailure } : {}),
    });
}
export function createRuntimeUserApplications(input) {
    const undeliveredMessages = createRuntimeUndeliveredSideMessages(input);
    // Replacing the objective keeps the Goal id: its undelivered rows stay but
    // stop pausing or resuming it (spec 4.6).
    input.goalPort.observeObjectiveReplaced((goal) => undeliveredMessages.detachGoal(goal.sessionId, goal.goalId));
    return {
        conversation: createRuntimeConversationApplication({
            undeliveredMessages,
            sessionSystem: input.sessionSystem,
            turnSystem: input.owners.turnSystem,
            runtimeConversation: input.owners.runtimeConversation,
            prepareForSessionStart: async (sessionId) => {
                await input.workspaceIndexing.prepareSessionStart(sessionId);
            },
            attachmentRegistration: input.options.compatibility.attachmentRegistration,
            pauseActiveForAbort: input.goalPort.pauseActiveForAbort,
            metrics: input.options.metrics,
            queryCollapseKeys: input.queryCollapseKeys,
        }),
        skill: input.createSkillApplication(input.owners.plugin, input.sessionSystem.sessions.query, input.agentSessionPorts, { nowMs: input.nowMs, management: input.owners.skillSystem.management }),
    };
}
export function createRuntimeProcessLocalApplication(input) {
    const { goals, options, owners, sessionSystem, skill, planEntryEnabled, modelSystem, modelProviderApplication, } = input;
    return composeProcessLocalApplication({
        goals,
        eventBus: options.eventBus,
        usageCommits: sessionSystem.usage.commits,
        compatibility: options.compatibility,
        listRuntimeSkills: (request) => skill.listRuntimeSkills(request),
        listSkills: owners.skillSystem.management.listSkills,
        plugins: owners.plugin.plugin,
        pluginControl: owners.plugin,
        miniApp: owners.miniAppComposition.services.miniApp,
        miniAppAgent: owners.miniAppAgent,
        ...(owners.miniAppComposition.services.miniAppTools
            ? { miniAppTools: owners.miniAppComposition.services.miniAppTools }
            : {}),
        planEntryEnabled,
        sessionReports: sessionSystem.reporting,
        instructions: {
            listSources: (request) => readLocalInstructionSources({ ...request, dataDir: options.dataDir }),
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
}
//# sourceMappingURL=runtime-user-applications.js.map