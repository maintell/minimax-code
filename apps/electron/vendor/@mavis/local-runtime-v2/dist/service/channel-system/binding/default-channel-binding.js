export function buildAgentDefaultChannelContext(platform, agentName, clientName) {
    return {
        platform,
        chatType: 'agent',
        chatId: agentName,
        senderId: agentName,
        clientName,
        lane: 'interactive',
    };
}
export async function bindAgentDefaultChannelBinding(infra, platform, agentName, clientName) {
    const ctx = buildAgentDefaultChannelContext(platform, agentName, clientName);
    // Migration doc §接入点 4: initialise the Access Control default
    // policy for the freshly-bound clientName so a UI panel can edit it
    // without an explicit API call. Best-effort and never overrides an
    // existing entry — see `LocalAccessControlStore.ensureDefaultPolicy`.
    if (infra.accessControlStore) {
        await infra.accessControlStore.ensureDefaultPolicy(platform, clientName);
    }
    // This helper is used only by pre-Connection bind ingress. Keep those
    // callers compatible for one transition period without allowing any new
    // `connection_id` chain to synthesize legacy route rows.
    const route = await infra.routeResolver.resolveLegacy(ctx);
    if (route.blocked || !route.sessionId)
        return undefined;
    return route.binding;
}
export async function deleteAgentPlatformChannelBindings(infra, platform, agentName) {
    const bindings = await infra.bindingStore.list({ agentName });
    let deleted = 0;
    for (const binding of bindings) {
        if (binding.platform !== platform)
            continue;
        if (await infra.bindingStore.deleteByKey(binding.key))
            deleted++;
    }
    return deleted;
}
//# sourceMappingURL=default-channel-binding.js.map