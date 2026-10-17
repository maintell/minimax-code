import { eq, inArray } from 'drizzle-orm';
import { sessions } from '../../../../infra/db/schema/sessions.js';
import { isPrimarySessionAgentName, PRIMARY_SESSION_AGENT_NAMES } from '../agent-name.js';
export function sessionAgentNamePredicate(agentName) {
    if (!agentName)
        return undefined;
    return isPrimarySessionAgentName(agentName)
        ? inArray(sessions.agentName, [...PRIMARY_SESSION_AGENT_NAMES])
        : eq(sessions.agentName, agentName);
}
//# sourceMappingURL=agent-name-predicate.js.map