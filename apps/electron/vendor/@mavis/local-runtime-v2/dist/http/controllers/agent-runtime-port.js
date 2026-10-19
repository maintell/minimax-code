import { createAgentController } from './agent.controller.js';
import {} from '../../service/session-system/index.js';
/**
 * V1 transport/desktop consumers use this bridge while V2 remains the only
 * Agent owner. The HTTP controller remains the single wire-mapping boundary;
 * builtin content is supplied by the V2 application read model.
 */
export function createV2AgentRuntimeManagementPort(input) {
    const controller = createAgentController(input.application);
    const context = {};
    return {
        listAgents: (request) => controller.listAgents(context, request),
        createAgent: (request) => controller.createAgent(context, request),
        getAgent: (request) => controller.getAgent(context, request),
        updateAgent: (request) => controller.updateAgent(context, request),
        deleteAgent: (request) => controller.deleteAgent(context, request),
        readCustomAgentAvatar: (agentName) => input.service.readCustomAvatar(agentName),
        setMainSession: (agentName, sessionId) => input.application.setRootSession(agentName, sessionId),
        // This is a storage predicate, not a canonical view lookup: old installs
        // may render Mavis while persisting only Main.
        agentExists: async (agentName) => Boolean(await input.service.getPersistedOwner(agentName)),
        canDelegate: async (agentName) => {
            const scope = await input.service.resolveAgentReadScope(agentName);
            const profile = await input.service.renderProfile({
                exactOwnerName: scope.exactOwnerName,
                requestRef: agentName,
                surface: 'interactive',
                appMode: 'coding',
                promptChannel: 'online',
            });
            const tools = profile.capabilityCeiling.tools;
            return (profile.capabilityCeiling.features.mavis &&
                profile.capabilityCeiling.features.delegation &&
                (tools === undefined || tools.includes('bash')));
        },
        listLegacyPinnedAgentRefs: async () => [
            ...(await input.application.listLegacyPinnedAgentRefs()),
        ],
        ensureBuiltinAgents: async () => {
            await input.application.ensureBuiltinDefinitionsForPhase2();
        },
        retryBuiltinGreetings: async () => undefined,
        getAgentOwnerIdentity: async (requestRef) => {
            const document = await input.application.getConfigDocument(requestRef);
            return {
                exactOwnerName: document.exactOwnerName,
                ownerKind: document.ownerKind,
                ...(document.ownerInstanceId ? { ownerInstanceId: document.ownerInstanceId } : {}),
            };
        },
        getSessionAgentRoutingSnapshot: async (sessionId) => {
            const routing = await input.readSessionAgentRouting(sessionId);
            if (!routing)
                return undefined;
            const definition = routing.definition?.definition;
            if (definition?.definitionVersion === 2) {
                return {
                    exactOwnerName: definition.exactOwnerName,
                    ...(definition.ownerInstanceId ? { ownerInstanceId: definition.ownerInstanceId } : {}),
                };
            }
            const owner = await input.application.getConfigDocument(`agent:${routing.session.agentName}`);
            return {
                exactOwnerName: owner.exactOwnerName,
                ...(owner.ownerInstanceId ? { ownerInstanceId: owner.ownerInstanceId } : {}),
            };
        },
        getSessionProjectIdentity: (sessionId) => input.resolveSessionProjectIdentity(sessionId),
    };
}
//# sourceMappingURL=agent-runtime-port.js.map