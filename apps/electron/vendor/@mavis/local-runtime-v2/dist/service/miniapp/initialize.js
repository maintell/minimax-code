import { HostMiniAppPortRegistry } from './process/node-runtime/port-registry.js';
import { DrizzleMiniAppStateStore } from './supervisor/state.repository.js';
import { createMiniAppHostConnectorSessionFactory } from './process/host-connector/host-connector.js';
import { createMiniAppNodeRuntimeAdapter } from './process/node-runtime/node-runtime.js';
import { DefaultMiniAppSupervisor } from './supervisor/supervisor.js';
/** Host-only production assembly seam. Recovery starts later through RuntimeServices.ready(). */
export function initializeMiniAppSupervisor(options) {
    const ports = new HostMiniAppPortRegistry(options.productReservedPorts);
    const nodeRuntime = createMiniAppNodeRuntimeAdapter({
        resolvePluginDataDir: options.resolvePluginDataDir,
        verifyCandidate: options.verifyCandidate,
        materializePackage: options.materializePackage,
        isPortReserved: (input) => ports.isReserved(input),
        reservePort: (input) => ports.reserve(input),
        hostConnectorSessionFactory: createMiniAppHostConnectorSessionFactory({
            gateway: options.connectorGateway,
        }),
    });
    const supervisor = new DefaultMiniAppSupervisor({
        stateStore: new DrizzleMiniAppStateStore(options.db),
        nodeRuntime,
        verifyCandidate: options.verifyCandidate,
        ...(options.nowMs ? { nowMs: options.nowMs } : {}),
        ...(options.closeTimeoutMs ? { closeTimeoutMs: options.closeTimeoutMs } : {}),
        ...(options.idleTimeoutMs ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
        ...(options.logCapacity ? { logCapacity: options.logCapacity } : {}),
    });
    return supervisor;
}
//# sourceMappingURL=initialize.js.map