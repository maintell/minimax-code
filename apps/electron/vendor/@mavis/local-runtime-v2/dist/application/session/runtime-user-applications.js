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
//# sourceMappingURL=runtime-user-applications.js.map