import { toAgentRequestRef } from '@mavis/agent-tools/desktop/subagent-roles';
import { parseExplicitStableName } from './contract.js';
import { isAgentNotFoundError } from './runtime-port.js';
/** Project a persisted exact owner to the requestRef exposed to clients. */
export async function projectPersistedAgentRequestRef(agentService, exactOwnerName) {
    const explicit = exactOwnerName.toLowerCase().startsWith('agent:');
    const exact = parseExplicitStableName(exactOwnerName);
    const exactAgent = await readPersistedAgentDetail(agentService, exact);
    const executionTarget = await agentService.resolveAgentExecutionTarget(exact);
    if (executionTarget !== exact)
        return executionTarget;
    if (explicit)
        return `agent:${exact}`;
    return toAgentRequestRef(exactAgent) ?? exact;
}
export async function readPersistedAgentDetail(agentService, name) {
    try {
        // Persisted refs are owner keys. Never reinterpret a manual reserved name
        // through the public bare-alias lookup path.
        const exactName = name.toLowerCase().startsWith('agent:') ? name : `agent:${name}`;
        return (await agentService.getAgent({ name: exactName, include: 'identity' })).agent;
    }
    catch (error) {
        if (isAgentNotFoundError(error))
            return undefined;
        throw error;
    }
}
//# sourceMappingURL=persisted-request-ref.js.map