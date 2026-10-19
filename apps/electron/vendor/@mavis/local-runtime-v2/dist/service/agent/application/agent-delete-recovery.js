import { logger } from '@mavis/shared/local-runtime-logging';
import { parseExplicitNameOrStable } from '../domain/names.js';
import { AgentServiceError } from '../errors.js';
import { AgentConfigError } from '../storage/canonical-agent-config.js';
/**
 * Deletes an Agent, keeping the builtin guard and adding a restricted
 * recovery path for an Agent whose `agent.md` no longer parses.
 *
 * Without the recovery branch, the lookup's `AgentConfigError` makes deletion
 * 500 as well and the user has no in-product way to remove the broken Agent
 * (MCT-202609-DBH04Q6E). Skipping the `isBuiltin` gate on that branch is safe
 * by construction: `repository.get()` resolves trusted builtin rows from the
 * DB without parsing user files, so an `AgentConfigError` can only originate
 * from the custom canonical parse path — the name is necessarily not a
 * builtin. `repository.delete()` itself is `files.withLock -> files.remove +
 * db delete` and does not depend on a parseable config. `AGENT_NOT_FOUND`
 * (and anything else) still propagates unchanged.
 */
export async function deleteAgentAllowingInvalidConfig(ports, requestRef) {
    let exactOwnerName;
    try {
        exactOwnerName = await ports.requireExactAgentKey(requestRef);
    }
    catch (error) {
        if (!(error instanceof AgentConfigError))
            throw error;
        const exactName = parseExplicitNameOrStable(requestRef);
        await ports.repository.delete(exactName);
        logger.info({
            agentName: exactName,
            code: error.code,
            message: error.message,
            reason: 'deleted-invalid-config-agent',
        }, 'Deleted an Agent whose canonical config failed to parse (restricted fail-soft delete)');
        return;
    }
    const meta = await ports.requireMeta(exactOwnerName);
    if (ports.isBuiltin(meta)) {
        throw new AgentServiceError('BUILTIN_AGENT_DELETE_FORBIDDEN', 'Built-in Agents cannot be deleted.');
    }
    await ports.repository.delete(meta.name);
}
//# sourceMappingURL=agent-delete-recovery.js.map