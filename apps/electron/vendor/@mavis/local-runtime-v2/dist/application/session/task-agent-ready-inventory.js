import { createTaskAgentBindingCaptureCoordinator, } from './task-agent-binding-capture.js';
/** Binds the ready-inventory Task capture after plugin and MCP owners exist. */
export function bindTaskAgentBindingCapture(input, services, diagnostics) {
    input.sessionSystem.sessions.records.bindTaskAgentBindingCapture(createTaskAgentBindingCaptureCoordinator({
        agentService: input.agentService,
        config: input.product.preparation.configBuilder.config,
        inventory: createTaskAgentReadyInventory({
            product: input.product,
            turnCapabilities: input.turnCapabilities,
            plugin: services.plugin,
            mcp: services.mcp,
        }),
        diagnostics,
        ...(input.options.runtimeOwnerKind
            ? { runtimeOwnerKind: input.options.runtimeOwnerKind }
            : {}),
        ...(input.options.capabilityProfile
            ? { capabilityProfile: input.options.capabilityProfile }
            : {}),
    }));
}
/** Captures the ready Desktop capability generation used to freeze a new Task. */
function createTaskAgentReadyInventory(input) {
    return {
        capture: ({ session, profile }) => capture(input, session, profile),
    };
}
async function capture(input, session, profile) {
    // Historical Task recovery can create a frozen binding before the Task's
    // first real Turn. Use the same ready capability owners that Turn admission
    // leases, rather than sampling stale configuration.
    await Promise.all([input.plugin.ready(), input.mcp.ready()]);
    const turnId = `session-agent-capture:${session.sessionId}:${profile.exactOwnerName}`;
    const lease = await input.turnCapabilities.acquire({ sessionId: session.sessionId, turnId });
    try {
        const builtinCapabilities = input.product.capabilities
            ? await input.product.capabilities.resolve(profile.exactOwnerName)
            : undefined;
        const sources = await input.product.toolSources.resolve({
            session,
            turnId,
            resourceAgentName: profile.resourceReadRef,
            ...(builtinCapabilities ? { builtinCapabilities } : {}),
            toolsDisabled: process.env.MAVIS_LOCAL_RUNTIME_DISABLE_TOOLS === '1',
            // Background Task children never inherit a foreground Plugin reference.
            computerUseActive: false,
            ...(lease.capabilities ? { desktopCapabilities: lease.capabilities } : {}),
        });
        const runtimeSkills = await input.product.preparation.configBuilder.skills.listRuntimeSkills(skillReadScope(session, profile));
        return {
            sources,
            ...(lease.capabilities ? { desktopCapabilities: lease.capabilities } : {}),
            skills: runtimeSkills.skills.map((skill) => ({
                name: skill.name,
                ...(skill.sourceType === undefined ? {} : { sourceType: skill.sourceType }),
            })),
        };
    }
    finally {
        lease.release();
    }
}
/** A frozen owner without an Agent row (Plugin Agent) must not resolve Agent resources. */
function skillReadScope(session, profile) {
    return {
        agentName: profile.resourceReadRef,
        workspaceDir: session.workspaceDir,
        ...(profile.excludeAgentResources ? { excludeAgentResources: true } : {}),
        ...(profile.skipAgentResolution ? { skipAgentResolution: true } : {}),
    };
}
//# sourceMappingURL=task-agent-ready-inventory.js.map