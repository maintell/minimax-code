const HOST_CAPABILITY_TARGET = Symbol('mavis.host-capability.target');
/**
 * The admitted Binding target behind a public tool the Host exposed in place of
 * it. A target exposed unchanged is a shared native tool and carries nothing.
 */
export function getHostCapabilityTarget(tool) {
    return tool[HOST_CAPABILITY_TARGET];
}
/** Preserve turn-local admission across the existing tool attribution wrappers. */
function withHostCapabilityTarget(exposed, reference) {
    if (exposed === reference.tool)
        return exposed;
    return { ...exposed, [HOST_CAPABILITY_TARGET]: reference };
}
/** Host-owned registry. Plugin packages can request these ids but cannot register adapters. */
export class HostCapabilityRegistry {
    adapters;
    reserveInlineGateway;
    constructor(adapters, options = {}) {
        this.reserveInlineGateway = options.reserveInlineGateway ?? true;
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
        const admission = {
            referenceRegistry: new Map(),
            disclosedReferences: new Map(),
            exposedTools: new Map(),
        };
        const ptc = input.ptc === true;
        for (const { binding, adapter } of admittedBindings(this.adapters, input)) {
            const key = capabilityKey(binding.hostCapability.id, binding.hostCapability.version);
            for (const target of targets.get(key) ?? []) {
                admitBindingTarget(admission, { adapter, binding, target, ptc });
            }
        }
        assertPublicToolNamesAvailable(admission.exposedTools, input.tools);
        return {
            publicTools: input.tools.flatMap((tool) => {
                if (!claimedTools.has(tool))
                    return [tool];
                const exposed = admission.exposedTools.get(tool);
                return exposed ? [exposed] : [];
            }),
            referenceRegistry: admission.referenceRegistry,
            ...(admission.disclosedReferences.size > 0
                ? { disclosedReferences: admission.disclosedReferences }
                : {}),
        };
    }
}
/** Bindings whose capability is registered, whose Skills are readable and whose surface is allowed. */
function admittedBindings(adapters, input) {
    return input.bindings.flatMap((binding) => {
        const adapter = adapters.get(capabilityKey(binding.hostCapability.id, binding.hostCapability.version));
        if (!adapter)
            return [];
        if (!binding.requiredSkillRuntimeNames.every((name) => input.availableSkillRuntimeNames.has(name))) {
            return [];
        }
        const surface = resolveBindingSurface(adapter, input.surface);
        if (!binding.allowedSurfaces.some((allowed) => allowed === surface))
            return [];
        return [{ binding, adapter }];
    });
}
/** Admits one target of one Binding; the first Binding to claim a tool_ref or a target wins. */
function admitBindingTarget(admission, input) {
    const { adapter, binding, target, ptc } = input;
    const alreadyAdmitted = admission.referenceRegistry.has(binding.toolRef) ||
        admission.disclosedReferences.has(binding.toolRef) ||
        admission.exposedTools.has(target);
    if (alreadyAdmitted)
        return;
    const reference = {
        tool: target,
        pluginName: binding.pluginName,
        requiredSkillRuntimeNames: binding.requiredSkillRuntimeNames,
        inputSchema: adapter.describeInput?.(target) ?? target.def.schema,
    };
    const admitted = admitTarget(adapter, target, reference, ptc);
    if (admitted.exposed)
        admission.exposedTools.set(target, admitted.exposed);
    if (admitted.reference)
        admission.referenceRegistry.set(binding.toolRef, reference);
    if (admitted.disclosed)
        admission.disclosedReferences.set(binding.toolRef, reference);
}
/**
 * Where one admitted target goes: behind the public tool its adapter builds,
 * behind a gateway reference, or — on a PTC Turn, which has no gateway — under
 * the target's own name, with the disclosure its Skill receipt still needs.
 */
function admitTarget(adapter, target, reference, ptc) {
    if (adapter.exposeTool) {
        return { exposed: withHostCapabilityTarget(adapter.exposeTool(reference), reference) };
    }
    if (!ptc)
        return { reference: true };
    return {
        exposed: withHostCapabilityTarget(onDemandHostTool(target), reference),
        disclosed: true,
    };
}
/**
 * The target itself, published under its own name for a PTC Turn. Declaring it
 * on demand keeps it out of the run_code SDK and the reminder, and puts it in
 * the Tool Search index the model reaches it through — the same shape the
 * exposed Browser already has on such a Turn.
 */
function onDemandHostTool(target) {
    return { ...target, def: { ...target.def, loading: 'on_demand' } };
}
function resolveBindingSurface(adapter, surface) {
    return adapter.resolveBindingSurface?.(surface) ?? surface;
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