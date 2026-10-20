import { ModelFavoritesPreference } from '../../service/model-system/index.js';
import { composeProcessLocalApplication } from './process-local-composition.js';
import { readLocalInstructionSources } from '../../service/turn-system/index.js';
import { createRuntimeConversationApplication } from '../conversation/runtime-conversation-application.js';
export function createRuntimeUserApplications(input) {
    return {
        conversation: createRuntimeConversationApplication({
            sessionSystem: input.sessionSystem,
            turnSystem: input.owners.turnSystem,
            runtimeConversation: input.owners.runtimeConversation,
            prepareForSessionStart: async (sessionId) => {
                await input.workspaceIndexing.prepareSessionStart(sessionId);
            },
            attachmentRegistration: input.options.compatibility.attachmentRegistration,
            pauseActiveForAbort: input.options.compatibility.sessionV2.goals.pauseActiveForAbort,
            metrics: input.options.metrics,
            queryCollapseKeys: input.queryCollapseKeys,
        }),
        skill: input.createSkillApplication(input.owners.plugin, input.sessionSystem.sessions.query, input.agentSessionPorts, { nowMs: input.nowMs, management: input.owners.skillSystem.management }),
    };
}
export function createRuntimeProcessLocalApplication(input) {
    const { options, owners, sessionSystem, skill, planEntryEnabled, modelSystem, modelProviderApplication, } = input;
    return composeProcessLocalApplication({
        eventBus: options.eventBus,
        usageCommits: sessionSystem.usage.commits,
        compatibility: options.compatibility,
        listRuntimeSkills: (request) => skill.listRuntimeSkills(request),
        listSkills: owners.skillSystem.management.listSkills,
        plugins: owners.plugin.plugin,
        pluginControl: owners.plugin,
        miniApp: owners.miniAppComposition.services.miniApp,
        miniAppAgent: owners.miniAppAgent,
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