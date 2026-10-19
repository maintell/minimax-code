export class AgentNameResolverError extends Error {
    agentName;
    reason;
    constructor(agentName, reason) {
        super(`cannot resolve agent name "${agentName}": ${reason}`);
        this.agentName = agentName;
        this.reason = reason;
        this.name = 'AgentNameResolverError';
    }
}
export function createResolverCache() {
    return { nameToId: new Map(), idToName: new Map(), loaded: false };
}
/**
 * Populate the cache from the full agent list (paginated ListAgent RPC).
 * No-op if already loaded.
 */
async function ensureLoaded(archonServer, cache, signal) {
    if (cache.loaded)
        return;
    let cursor;
    do {
        const resp = await archonServer.callRpc('ListAgent', { page: { cursor, limit: 100 } }, signal);
        for (const agent of resp.agents ?? []) {
            if (agent.display_name) {
                cache.nameToId.set(agent.display_name, agent.agent_id);
            }
            cache.idToName.set(agent.agent_id, agent.display_name ?? agent.agent_id);
        }
        cursor = resp.has_more ? resp.next_cursor : undefined;
    } while (cursor);
    cache.loaded = true;
}
/**
 * Resolve an `agent_name` (display_name) to an `agent_id`.
 * Throws `AgentNameResolverError` when no matching agent is found.
 */
export async function resolveAgentName(archonServer, agentName, cache, signal) {
    await ensureLoaded(archonServer, cache, signal);
    const agentId = cache.nameToId.get(agentName);
    if (!agentId) {
        const available = [...cache.nameToId.keys()];
        throw new AgentNameResolverError(agentName, `no agent found with display_name "${agentName}". Available: ${available.length > 0 ? available.join(', ') : '(none)'}`);
    }
    return agentId;
}
/**
 * Reverse-resolve an `agent_id` back to its `display_name`.
 * Falls back to the raw `agent_id` string when no mapping exists.
 */
export async function resolveAgentId(archonServer, agentId, cache, signal) {
    await ensureLoaded(archonServer, cache, signal);
    return cache.idToName.get(agentId) ?? agentId;
}
//# sourceMappingURL=agent-name-resolver.js.map