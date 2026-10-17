import { AgentConfigError, AgentServiceError, } from '../../service/agent/index.js';
/**
 * Builds the Agent lookup `PinService` hydrates pinned refs through.
 *
 * Fail-soft isolation for a broken `agent.md` lives here — at the aggregation
 * consumer — and deliberately not in `repository.get()`: exact reads (opening
 * or editing one Agent) must keep surfacing the field-level
 * `AgentConfigError` diagnostic, while aggregate views built on top of pin
 * hydration (sidebar query, pinned-items order) must degrade the one broken
 * Agent to a missing entry instead of failing the whole response
 * (MCT-202609-DBH04Q6E: two Agents with invalid YAML frontmatter kept the
 * entire sidebar at 500).
 *
 * Returning `undefined` hands the degradation to existing `PinService`
 * semantics: `getOrder()` preserves the bare ref (`preserveMissing`),
 * `putOrder()` keeps already-pinned refs via its existing-keys allowance, and
 * newly pinning a broken Agent is still rejected as agent-not-found.
 */
export function createPinnedAgentLookup(input) {
    return async (agentName) => {
        try {
            let exactOwnerName;
            try {
                exactOwnerName = await input.agentService.requireExactAgentKey(agentName);
            }
            catch (error) {
                // Missing Agents intentionally stay a silent `undefined`; only this
                // exact code is swallowed so other service failures keep propagating.
                if (error instanceof AgentServiceError && error.code === 'AGENT_NOT_FOUND')
                    return undefined;
                throw error;
            }
            const agent = await input.agentService.getPersistedOwner(exactOwnerName);
            if (!agent)
                return undefined;
            return toPinAgentRecord(agentName, exactOwnerName, agent);
        }
        catch (error) {
            // Only the canonical-config parse failure is degraded; anything else
            // (storage faults, unexpected service errors) keeps failing loudly.
            if (!(error instanceof AgentConfigError))
                throw error;
            input.logger.warn({
                agentName,
                code: error.code,
                message: error.message,
                reason: 'pin-agent-config-invalid',
            }, 'Pinned Agent has an invalid canonical config; hydrating it as missing instead of failing the pin aggregate');
            return undefined;
        }
    };
}
/** Projects a persisted owner to the pin wire record, keeping the explicit-ref request shape. */
function toPinAgentRecord(requestedName, exactOwnerName, agent) {
    return {
        agentName: requestedName.toLowerCase().startsWith('agent:')
            ? `agent:${exactOwnerName}`
            : agent.requestRef,
        ...(agent.rootSessionId ? { rootSessionId: agent.rootSessionId } : {}),
        ...(agent.displayName ? { displayName: agent.displayName } : {}),
        ...(agent.defaultWorkspaceDir ? { defaultWorkspaceDir: agent.defaultWorkspaceDir } : {}),
    };
}
//# sourceMappingURL=pin-agent-lookup.js.map