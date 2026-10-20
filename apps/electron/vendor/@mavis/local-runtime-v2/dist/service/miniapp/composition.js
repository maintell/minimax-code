import { join } from 'node:path';
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
    try {
        if (input.options) {
            miniApp = initializeMiniAppSupervisor({
                ...input.options,
                db: input.db,
                connectorGateway: input.plugin.hostConnectorGateway,
                ...(input.agentGateway ? { agentGateway: input.agentGateway } : {}),
                ...(input.logger ? { logger: input.logger } : {}),
                verifyCandidate: (candidate) => input.plugin.verifyMiniAppCandidate(candidate),
                materializePackage: (materialization) => input.plugin.materializeMiniAppRuntimePackage(materialization),
                // Plugin-authored context.dataDir is persistent state. Keep the shipped physical root.
                resolvePluginDataDir: (pluginId) => join(input.dataDir, 'v2', 'plugin-data', 'liveboards', encodeURIComponent(pluginId)),
                nowMs: input.nowMs,
            });
            input.plugin.attachMiniAppPublication({ supervisor: miniApp });
        }
    }
    catch (error) {
        await closeAfterInitializationFailure(miniApp, input.closeOwners);
        throw error;
    }
    return {
        services: miniApp ? { miniApp } : {},
        ready: createCombinedReady(miniApp, input.readyOwners),
        close: createCombinedClose(input.closeOwners, miniApp),
    };
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