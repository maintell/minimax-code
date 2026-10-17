import { EventBus } from './infra/event-bus/index.js';
import { createForkWorktreeAdapter } from './infra/git/fork-worktree-adapter.js';
import { createProcessLocalRuntimeOwnerIdentity, createRuntimeOwnerIdentity, } from './infra/runtime-owner/index.js';
import { Scheduler } from './infra/scheduler/index.js';
import { pruneTransientStorage } from './infra/storage-retention/index.js';
export async function createBackgroundRuntime(options) {
    const runtimeOwnerIdentity = options.dataDir
        ? await createRuntimeOwnerIdentity({ dataDir: options.dataDir })
        : createProcessLocalRuntimeOwnerIdentity();
    let scheduler;
    let eventBus;
    let forkWorktree;
    try {
        scheduler =
            options.enableScheduler === false
                ? undefined
                : new Scheduler({
                    db: options.db,
                    ...(options.metrics ? { metrics: options.metrics } : {}),
                    ...(options.nowMs ? { nowMs: options.nowMs } : {}),
                });
        eventBus = new EventBus();
        forkWorktree = createForkWorktreeAdapter({});
    }
    catch (error) {
        await runtimeOwnerIdentity.close();
        throw error;
    }
    let startPromise;
    let maintenancePromise;
    let stopPromise;
    let closePromise;
    const maintenanceTasks = [];
    if (options.dataDir) {
        maintenanceTasks.push({
            name: 'transient-storage-retention',
            run: () => prunePostReadyTransientStorage(options),
        });
    }
    const close = () => {
        closePromise ??= closeBackgroundInfrastructure();
        return closePromise;
    };
    const stop = () => {
        stopPromise ??= stopBackgroundInfrastructure();
        return stopPromise;
    };
    const start = () => {
        startPromise ??= startInfrastructure();
        return startPromise;
    };
    const registerMaintenance = (name, task) => {
        if (maintenancePromise)
            throw new Error('Background maintenance already started');
        maintenanceTasks.push({ name, run: task });
    };
    const startMaintenance = () => {
        maintenancePromise ??= runDeferredMaintenance();
    };
    async function runDeferredMaintenance() {
        await deferMaintenance();
        await runMaintenanceTasks();
    }
    async function runMaintenanceTasks() {
        await Promise.all(maintenanceTasks.map(async ({ name, run }) => {
            try {
                await run();
            }
            catch (error) {
                options.logger?.warn({ error, maintenance: name }, 'local-runtime-v2 background maintenance failed');
            }
        }));
    }
    async function stopBackgroundInfrastructure() {
        try {
            if (scheduler)
                scheduler.stop();
        }
        finally {
            eventBus.close();
        }
    }
    async function closeBackgroundInfrastructure() {
        let firstError;
        try {
            await stop();
        }
        catch (error) {
            firstError = error;
        }
        try {
            await maintenancePromise;
        }
        catch (error) {
            firstError ??= error;
        }
        try {
            await runtimeOwnerIdentity.close();
        }
        catch (error) {
            firstError ??= error;
        }
        if (firstError !== undefined)
            throw firstError;
    }
    async function startInfrastructure() {
        try {
            if (scheduler) {
                scheduler.start({
                    restorePersistedJobExecution: options.restorePersistedJobExecution !== false,
                });
            }
        }
        catch (error) {
            try {
                await close();
            }
            catch {
                // Startup cleanup is best effort; the Scheduler failure remains primary.
            }
            throw error;
        }
    }
    return {
        clients: {
            ...(scheduler ? { scheduler } : {}),
            eventBus,
            runtimeOwnerIdentity,
            forkWorktree,
        },
        start,
        registerMaintenance,
        startMaintenance,
        stop,
        close,
    };
}
function deferMaintenance() {
    return new Promise((resolve) => setImmediate(resolve));
}
async function prunePostReadyTransientStorage(options) {
    if (!options.dataDir)
        return;
    const retention = await pruneTransientStorage({
        dataDir: options.dataDir,
        ...(options.nowMs ? { nowMs: options.nowMs } : {}),
    });
    if (retention.logFilesDeleted <= 0 && !retention.retiredContextDebugDeleted) {
        return;
    }
    options.logger?.info({ ...retention }, 'local-runtime-v2 transient storage retention completed');
}
//# sourceMappingURL=background-runtime.js.map