/** @deprecated Remove this forwarding adapter after the hosted consumer moves to v2. */
export function createHostedSkillCapabilities(host, restrictions) {
    const context = {
        restrictions,
    };
    return {
        listRuntimeSkills: (scope) => host.skillRuntime.listHostedRuntimeSkills(scope, context),
        listCatalogEntries: (scope) => host.skillRuntime.listHostedCatalogEntries(scope, context),
    };
}
//# sourceMappingURL=hosted-agent-skill-capabilities.js.map