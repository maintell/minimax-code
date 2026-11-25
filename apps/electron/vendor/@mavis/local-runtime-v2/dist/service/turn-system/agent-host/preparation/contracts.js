/**
 * The namespace Skill gates for this exact Turn, asked of the host that owns
 * the adapters. Absent on hosts that never register namespaced tools, which is
 * the same answer as "no group has tools here".
 */
export function namespacedSkillScope(session, runtimeFacts, profile, hostFeatures) {
    const gates = hostFeatures.namespacedSkillGates?.({
        session,
        resourceAgentName: runtimeFacts.resourceAgentName,
        ...(profile?.excludeAgentResources ? { excludeAgentResources: true } : {}),
        agentMemoryEnabled: (profile?.memoryReadAgentNames.length ?? 0) > 0,
    });
    return gates ?? {};
}
//# sourceMappingURL=contracts.js.map