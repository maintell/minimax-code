import { composeMiniAppRuntimeCapability } from '../../service/miniapp/index.js';
import { createMainAgentMiniAppToolCallObserver } from './miniapp-agent-wiring.js';
import { miniAppToolHostPorts } from './runtime-service-ports.js';
/** The Supervisor and memory manager; main-Agent MCP calls hold their plugin for the turn. */
export async function composeRuntimeMiniApp(input, owners) {
    const composition = await composeMiniAppRuntimeCapability({
        options: owners.options,
        db: input.options.db,
        dataDir: input.options.dataDir,
        nowMs: input.nowMs,
        plugin: owners.plugin,
        agentGateway: owners.agentGateway,
        surface: input.options.compatibility.miniAppSurface,
        tools: miniAppToolHostPorts(input.options.compatibility, owners.mcpRuntime),
        logger: owners.logger,
        readyOwners: input.readyOwners,
        closeOwners: input.closeOwners,
    });
    const memory = composition.services.miniAppMemory;
    if (memory) {
        owners.plugin.observeManagedMiniAppToolCalls(createMainAgentMiniAppToolCallObserver({
            repository: input.sessionSystem.sessions.repository,
            logger: owners.logger,
            memory,
        }));
    }
    return composition;
}
//# sourceMappingURL=runtime-miniapp-composition.js.map