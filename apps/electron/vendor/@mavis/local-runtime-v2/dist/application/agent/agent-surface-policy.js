import path from 'node:path';
import { hidesCoordinatorRootSessions, isCoordinatorAgent, keepsPrivateHomeDir, } from '@mavis/shared/agent-coordination';
/**
 * Session surface facts of the bundled built-in Agents, read from their coordinator
 * capabilities once. Only the built-in catalog declares coordination, so a Custom or Plugin
 * Agent is always ordinary.
 */
export function createBuiltinAgentSurfacePolicy(input) {
    const read = readOnce(async () => {
        const definitions = await input.agents.listBuiltinDefinitions();
        return {
            hiddenRootAgents: new Set(definitions
                .filter((definition) => hidesCoordinatorRootSessions(definition.coordination))
                .map((definition) => definition.name)),
            privateWorkspaceRoots: definitions
                .filter((definition) => keepsPrivateHomeDir(definition.coordination))
                .map((definition) => path.join(input.dataDir, definition.name)),
        };
    });
    return {
        hidesRootSessions: async (agentName) => (await read()).hiddenRootAgents.has(agentName),
        privateWorkspaceRoots: async () => (await read()).privateWorkspaceRoots,
    };
}
/**
 * Whether an Agent is a bundled coordinator, read from the built-in catalog once. Custom and
 * Plugin Agents never are.
 */
export function createBuiltinCoordinatorAgents(input) {
    const read = readOnce(async () => {
        const definitions = await input.agents.listBuiltinDefinitions();
        return new Set(definitions
            .filter((definition) => isCoordinatorAgent(definition.coordination))
            .map((definition) => definition.name));
    });
    return async (agentName) => (await read()).has(agentName);
}
/** Shares one read between callers; a failed read is retried by the next caller, not cached. */
function readOnce(load) {
    let pending;
    const attempt = async () => {
        try {
            return await load();
        }
        catch (error) {
            pending = undefined;
            throw error;
        }
    };
    return () => {
        pending ??= attempt();
        return pending;
    };
}
//# sourceMappingURL=agent-surface-policy.js.map