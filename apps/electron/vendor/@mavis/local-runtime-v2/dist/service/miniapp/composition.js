import { join } from 'node:path';
import { createMiniAppToolGateway } from './tool-gateway.js';
import { initializeMiniAppSupervisor, } from './initialize.js';
export function resolveRuntimeMiniAppOptions(input) {
    if (input.runtimeOwnerKind !== undefined && input.runtimeOwnerKind !== 'electron') {
        return undefined;
    }
    if (input.miniApp)
        return input.miniApp;
    return input.runtimeOwnerKind === 'electron' ? {} : undefined;
}
export function createDeferredRuntimeOwnersLifecycle() {
    let lifecycle;
    const requireLifecycle = () => {
        if (!lifecycle)
            throw new Error('Runtime owner lifecycle is not bound');
        return lifecycle;
    };
    return {
        ready: () => requireLifecycle().ready(),
        close: () => requireLifecycle().close(),
        bind(next) {
            if (lifecycle)
                throw new Error('Runtime owner lifecycle is already bound');
            lifecycle = next;
        },
    };
}
/** Owns optional Supervisor initialization and ordered shutdown at the Host composition boundary. */
export async function composeMiniAppRuntimeCapability(input) {
    let miniApp;
    let miniAppTools;
    try {
        if (input.options) {
            miniAppTools = composeMiniAppToolGateway(input);
            const supervisor = initializeMiniAppSupervisor({
                ...input.options,
                db: input.db,
                connectorGateway: input.plugin.hostConnectorGateway,
                permissionSwitches: input.plugin.miniAppPermissionSwitches,
                toolGateway: miniAppTools,
                ...(input.agentGateway ? { agentGateway: input.agentGateway } : {}),
                ...(input.logger ? { logger: input.logger } : {}),
                verifyCandidate: (candidate) => input.plugin.verifyMiniAppCandidate(candidate),
                materializePackage: (materialization) => input.plugin.materializeMiniAppRuntimePackage(materialization),
                // Plugin-authored context.dataDir is persistent state. Keep the shipped physical root.
                resolvePluginDataDir: (pluginId) => join(input.dataDir, 'v2', 'plugin-data', 'liveboards', encodeURIComponent(pluginId)),
                nowMs: input.nowMs,
            });
            miniApp = supervisor;
            input.plugin.attachMiniAppPublication({
                supervisor,
                onRuntimeExit: (listener) => supervisor.onRuntimeExit(listener),
            });
        }
    }
    catch (error) {
        await closeAfterInitializationFailure(miniApp, input.closeOwners);
        throw error;
    }
    return {
        services: miniApp ? { miniApp, ...(miniAppTools ? { miniAppTools } : {}) } : {},
        ready: createCombinedReady(miniApp, input.readyOwners),
        close: createCombinedClose(input.closeOwners, miniApp),
    };
}
function composeMiniAppToolGateway(input) {
    const { tools, logger } = input;
    return createMiniAppToolGateway({
        connectorGateway: input.plugin.hostConnectorGateway,
        pluginMcp: input.plugin.miniAppPluginMcp,
        ...(tools?.localMcp ? { localMcp: tools.localMcp } : {}),
        ...(tools?.permissions ? { permissions: tools.permissions } : {}),
        ...(tools?.approvals ? { approvals: tools.approvals } : {}),
        // The same switches the Connector and Agent gateways read (`tool:call`).
        permissionSwitches: input.plugin.miniAppPermissionSwitches,
        audit: {
            // Audit is log-only; a logger without `info` still records it as a warning.
            record: (event) => {
                const write = logger?.info ?? logger?.warn;
                write?.call(logger, { ...event }, 'Mini App tool audit');
            },
        },
    });
}
function createCombinedReady(miniApp, readyOwners) {
    let readyPromise;
    return () => {
        readyPromise ??= readyMiniAppAfterOwners(miniApp, readyOwners);
        return readyPromise;
    };
}
async function readyMiniAppAfterOwners(miniApp, readyOwners) {
    await readyOwners();
    await miniApp?.ready();
}
async function closeAfterInitializationFailure(miniApp, closeOwners) {
    for (const close of [closeOwners, () => miniApp?.close()]) {
        try {
            await close();
        }
        catch {
            // Preserve the initialization error after best-effort cleanup of acquired owners.
        }
    }
}
function createCombinedClose(closeOwners, miniApp) {
    let closePromise;
    return () => {
        closePromise ??= closeOwnersAndMiniApp(closeOwners, miniApp);
        return closePromise;
    };
}
async function closeOwnersAndMiniApp(closeOwners, miniApp) {
    let firstError;
    try {
        await closeOwners();
    }
    catch (error) {
        firstError = error;
    }
    try {
        await miniApp?.close();
    }
    catch (error) {
        firstError ??= error;
    }
    if (firstError)
        throw firstError;
}
//# sourceMappingURL=composition.js.map