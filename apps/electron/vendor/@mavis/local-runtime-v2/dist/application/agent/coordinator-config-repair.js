import { AgentServiceError } from '../../service/agent/index.js';
/** How far a preparation failure is unwrapped to find the configuration error. */
const MAX_CAUSE_DEPTH = 4;
/**
 * Emergency rebuild spec 8: a Turn whose preparation failed because a
 * coordinator's own built-in configuration is corrupt gets it rewritten by the
 * Agent service, then prepares again. Any other failure, including another
 * built-in Agent's corrupt configuration, is not this repair's.
 */
export function createCoordinatorConfigRepair(agents) {
    return {
        repair: async (error) => {
            const agentName = brokenBuiltinConfigAgent(error);
            if (agentName === undefined)
                return { status: 'not_applicable' };
            const outcome = await agents.repairCorruptedCoordinatorConfig(agentName);
            if (outcome.status === 'repaired') {
                return { status: 'repaired', backupFile: outcome.backupFile };
            }
            // A file that was valid or gone by the time the repair looked, or a
            // Builtin without a use-time repair, has nothing to rewrite; the Turn
            // fails as it does today.
            return outcome.status === 'failed' ? { status: 'failed' } : { status: 'not_applicable' };
        },
    };
}
/** The Builtin whose corrupt configuration failed the preparation, if that is what failed it. */
function brokenBuiltinConfigAgent(error) {
    let current = error;
    for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
        if (current instanceof AgentServiceError && current.code === 'BUILTIN_AGENT_CONFIG_BROKEN') {
            const agentName = current.details?.agentName;
            return typeof agentName === 'string' ? agentName : undefined;
        }
        current = current.cause;
    }
    return undefined;
}
//# sourceMappingURL=coordinator-config-repair.js.map