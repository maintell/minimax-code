export async function buildAgentChannelConfig(bindingStore, agentName) {
    const bindings = await bindingStore.list({ agentName });
    if (bindings.length === 0)
        return undefined;
    const config = {};
    for (const binding of bindings) {
        if (config[binding.platform])
            continue;
        config[binding.platform] = {
            session: {
                strategy: binding.strategy === 'pin' ? 'root' : binding.strategy,
                pinned_session_id: null,
            },
            message_filter: await bindingStore.getMessageFilter(binding.clientName),
        };
    }
    return config;
}
/**
 * Build the read-only channel config for one resolved AgentName family.
 *
 * Bindings stay exact-owner records. A platform can be merged when it has a
 * single configured family owner; two different owners on the same platform
 * are intentionally surfaced as ambiguity instead of selecting whichever
 * binding happens to be listed first.
 */
export async function buildAgentChannelConfigForAgents(bindingStore, agentNames) {
    const names = [...new Set(agentNames)].filter((name) => name.length > 0);
    const config = {};
    const owners = new Map();
    const candidates = [];
    const seenCandidates = new Set();
    const recordAmbiguity = (platform, agentA, agentB) => {
        for (const candidate of [
            { agentName: agentA, platform },
            { agentName: agentB, platform },
        ]) {
            const key = `${candidate.platform}:${candidate.agentName}`;
            if (seenCandidates.has(key))
                continue;
            seenCandidates.add(key);
            candidates.push(candidate);
        }
    };
    for (const agentName of names) {
        const ownerConfig = await buildAgentChannelConfig(bindingStore, agentName);
        if (!ownerConfig)
            continue;
        for (const [platform, value] of Object.entries(ownerConfig)) {
            const existingOwner = owners.get(platform);
            if (existingOwner !== undefined && existingOwner !== agentName) {
                recordAmbiguity(platform, existingOwner, agentName);
                continue;
            }
            if (existingOwner === undefined) {
                owners.set(platform, agentName);
                config[platform] = value;
            }
        }
    }
    return {
        ...(Object.keys(config).length > 0 ? { config } : {}),
        candidates,
    };
}
//# sourceMappingURL=agent-channel-config.js.map