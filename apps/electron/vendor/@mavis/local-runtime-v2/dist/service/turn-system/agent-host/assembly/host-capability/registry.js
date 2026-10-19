/** Host-owned registry. Plugin packages can request these ids but cannot register adapters. */
export class HostCapabilityRegistry {
    adapters;
    constructor(adapters) {
        const byCapability = new Map();
        for (const adapter of adapters) {
            const key = capabilityKey(adapter.capability.id, adapter.capability.version);
            if (byCapability.has(key)) {
                throw new Error(`Duplicate Host capability adapter: ${key}`);
            }
            byCapability.set(key, adapter);
        }
        this.adapters = byCapability;
    }
    prepare(input) {
        const { targets, claimedTools } = claimAdapterTargets(this.adapters, input.tools);
        const referenceRegistry = new Map();
        const exposedTools = new Map();
        const bindings = input.bindings.filter((binding) => binding.allowedSurfaces.some((surface) => surface === input.surface) &&
            binding.requiredSkillRuntimeNames.every((name) => input.availableSkillRuntimeNames.has(name)));
        for (const binding of bindings) {
            const key = capabilityKey(binding.hostCapability.id, binding.hostCapability.version);
            const adapter = this.adapters.get(key);
            if (!adapter)
                continue;
            for (const target of targets.get(key) ?? []) {
                if (referenceRegistry.has(binding.toolRef) || exposedTools.has(target))
                    continue;
                const reference = {
                    tool: target,
                    pluginName: binding.pluginName,
                    requiredSkillRuntimeNames: binding.requiredSkillRuntimeNames,
                    inputSchema: adapter.describeInput?.(target) ?? target.def.schema,
                };
                if (adapter.exposeTool) {
                    exposedTools.set(target, adapter.exposeTool(reference));
                }
                else {
                    referenceRegistry.set(binding.toolRef, reference);
                }
            }
        }
        assertPublicToolNamesAvailable(exposedTools, input.tools);
        return {
            publicTools: input.tools.flatMap((tool) => {
                if (!claimedTools.has(tool))
                    return [tool];
                const exposed = exposedTools.get(tool);
                return exposed ? [exposed] : [];
            }),
            referenceRegistry,
        };
    }
}
function assertPublicToolNamesAvailable(exposedTools, tools) {
    const publicNames = new Set();
    for (const [target, exposed] of exposedTools) {
        const name = normalizedToolName(exposed.def.name);
        if (publicNames.has(name) ||
            tools.some((tool) => tool !== target && normalizedToolName(tool.def.name) === name)) {
            throw new Error(`Host tool conflicts with an existing tool: ${exposed.def.name}`);
        }
        publicNames.add(name);
    }
}
function normalizedToolName(name) {
    return name.trim().normalize('NFKC').toLowerCase();
}
function capabilityKey(id, version) {
    return `${id}@${version}`;
}
function selectAdapterTargets(adapter, tools) {
    return (adapter.selectTargets?.(tools) ??
        [adapter.selectTarget?.(tools)].filter((tool) => Boolean(tool)));
}
function claimAdapterTargets(adapters, tools) {
    const targets = new Map();
    const claimedTools = new Set();
    for (const [key, adapter] of adapters) {
        const selected = selectAdapterTargets(adapter, tools);
        for (const target of selected) {
            if (claimedTools.has(target))
                throw new Error(`Host tool is claimed by more than one capability adapter: ${key}`);
            claimedTools.add(target);
        }
        targets.set(key, selected);
    }
    return { targets, claimedTools };
}
//# sourceMappingURL=registry.js.map