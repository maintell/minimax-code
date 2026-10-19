import { getRuntimeBuildEnv, getRuntimeRegion } from '@mavis/config';
import { BoundedInternalTurnPromptReadRegistry, } from '@mavis/agent-runtime';
import { initializeManagedDesktopPromptConfig } from '../initialize.js';
/** Composes the Desktop Prompt control plane without leaking it into runtime.ts. */
async function initializeRuntimePromptConfig(input) {
    const managed = await initializeManagedDesktopPromptConfig({
        enabled: input.enabled,
        dataDir: input.dataDir,
        ...(input.promptConfigKey ? { desktopKey: input.promptConfigKey } : {}),
        authContextGetter: input.plugin.authContextGetter,
        deploymentGetter: () => `${getRuntimeRegion()}-${getRuntimeBuildEnv()}`,
        fetchImpl: input.plugin.fetchImpl,
        ...(input.plugin.appVersion ? { appVersion: input.plugin.appVersion } : {}),
        ...(input.promptFileReader ? { reader: input.promptFileReader } : {}),
    });
    if (!managed)
        return undefined;
    input.agentService.bindPromptConfig(managed.owner.service);
    const snapshots = input.snapshotFactory.create({
        config: managed.owner.service,
        reader: managed.owner.reader,
        managedKeys: managed.managedPaths,
    });
    return {
        snapshots,
        ready: () => managed.owner.service.ready(),
        close: () => managed.owner.service.close(),
        notifyAuthContextChanged: () => {
            managed.auth.authContextChanged();
            queueMicrotask(() => void managed.owner.service.authContextChanged());
        },
    };
}
export async function initializeRuntimePromptSupport(input) {
    const internalTurnPromptReads = new BoundedInternalTurnPromptReadRegistry();
    try {
        const promptConfig = await initializeRuntimePromptConfig(input);
        return {
            promptConfig,
            promptSnapshots: promptConfig?.snapshots,
            internalTurnPromptReads,
        };
    }
    catch (error) {
        internalTurnPromptReads.close();
        throw error;
    }
}
export async function withRuntimePromptSupportRollback(support, operation) {
    try {
        return await operation();
    }
    catch (error) {
        await closeUnboundRuntimePromptSupport(support);
        throw error;
    }
}
export function bindRuntimePromptSupport(bindings, support) {
    bindings.promptSnapshots.bind(support.promptSnapshots);
    bindings.internalTurnPromptReads.bind(support.internalTurnPromptReads);
}
export function createRuntimePromptLifecycle(input) {
    let readyPromise;
    let closePromise;
    return {
        ready: () => {
            readyPromise ??= readyRuntimePromptLifecycle(input);
            return readyPromise;
        },
        close: () => {
            closePromise ??= closeRuntimePromptLifecycle(input);
            return closePromise;
        },
    };
}
async function readyRuntimePromptLifecycle(input) {
    await input.promptConfig?.ready();
    await input.lifecycle.ready();
}
async function closeRuntimePromptLifecycle(input) {
    let lifecycleFailure;
    try {
        await input.lifecycle.close();
    }
    catch (error) {
        lifecycleFailure = error;
    }
    input.bindings.promptSnapshots.bind(undefined);
    input.bindings.internalTurnPromptReads.bind(undefined);
    input.internalTurnPromptReads.close();
    let promptFailure;
    try {
        await input.promptConfig?.close();
    }
    catch (error) {
        promptFailure = error;
    }
    if (lifecycleFailure)
        throw lifecycleFailure;
    if (promptFailure)
        throw promptFailure;
}
async function closeUnboundRuntimePromptSupport(support) {
    support.internalTurnPromptReads.close();
    try {
        await support.promptConfig?.close();
    }
    catch {
        // Preserve the startup failure that made this support unreachable.
    }
}
//# sourceMappingURL=runtime-prompt-config.js.map