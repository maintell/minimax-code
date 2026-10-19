import { registerApplicationLifecycleModules } from "./application-modules";
import { LifecycleInitFatalError, LifecycleKernel } from "./kernel";
import { QuitCoordinator } from "./quit-coordinator";
/**
 * Translate the quit coordinator's accepted-plan result into the action
 * contract consumed by renderer recovery: fulfill only when this relaunch was
 * the winning plan and Electron actually dispatched it.
 */
export async function requestRendererRelaunch(quitCoordinator, source) {
    const result = await quitCoordinator.requestQuit({ kind: 'relaunch', source });
    if (result.status !== 'accepted') {
        throw new Error(`Renderer relaunch request was rejected: ${result.reason}`);
    }
    if (result.plan.kind !== 'relaunch') {
        throw new Error(`Renderer relaunch request was superseded by ${result.plan.kind}`);
    }
    if (result.terminalOutcome !== 'dispatched') {
        throw new Error('Renderer relaunch terminal action failed');
    }
}
/** Defer activate listener installation until the lifecycle owner is initialized. */
export function createActivateHandlerRegistrar(application, handler) {
    return () => {
        application.on('activate', handler);
    };
}
function failStartup(runtime, error) {
    try {
        void Promise.resolve(runtime.failStartup(error)).catch(() => undefined);
    }
    catch {
        // The shared fatal path owns logging and termination. There is no safe
        // second lifecycle coordinator to fall back to if that boundary throws.
    }
}
/**
 * Install the one Electron event bridge around an already-composed lifecycle
 * runtime. Registration and beforeReady startup remain synchronous; the
 * whenReady phase is sequenced only after Electron itself becomes ready.
 */
export function startApplicationBootstrap(runtime, channels) {
    const startupStartedAtMs = runtime.now?.() ?? Date.now();
    let beforeReadyResults = [];
    let startupObserved = false;
    const observeStartup = (outcome, results) => {
        if (startupObserved)
            return;
        startupObserved = true;
        try {
            runtime.observeStartup?.({
                outcome,
                durationMs: Math.max(0, (runtime.now?.() ?? Date.now()) - startupStartedAtMs),
                results,
            });
        }
        catch {
            // Telemetry must never become lifecycle control.
        }
    };
    const fatalResults = (error) => error instanceof LifecycleInitFatalError ? error.results : beforeReadyResults;
    runtime.app.on('before-quit', (event) => {
        runtime.onBeforeQuit(event);
        try {
            if (!startupObserved && !runtime.shouldContinueStartup()) {
                queueMicrotask(() => {
                    if (!startupObserved)
                        observeStartup('aborted-by-quit', beforeReadyResults);
                });
            }
        }
        catch {
            // A telemetry guard must not turn Electron's before-quit event into a new failure.
        }
    });
    runtime.app.on('will-quit', (event) => runtime.onWillQuit(event));
    runtime.ipcMain.on(channels.confirmQuitChannel, () => runtime.onRendererQuitConfirmed());
    runtime.ipcMain.on(channels.bringToFrontChannel, () => runtime.onBringToFront());
    try {
        runtime.registerModules();
        const results = runtime.runBeforeReady();
        if (Array.isArray(results))
            beforeReadyResults = results;
        if (!runtime.shouldContinueStartup()) {
            observeStartup('aborted-by-quit', beforeReadyResults);
            return;
        }
    }
    catch (error) {
        observeStartup('fatal', fatalResults(error));
        failStartup(runtime, error);
        return;
    }
    void runtime.app
        .whenReady()
        .then(() => {
        if (!runtime.shouldContinueStartup()) {
            observeStartup('aborted-by-quit', beforeReadyResults);
            return undefined;
        }
        runtime.onReady();
        return runtime.runWhenReady();
    })
        .then((results) => {
        if (startupObserved)
            return;
        observeStartup('ready', Array.isArray(results) ? results : beforeReadyResults);
    })
        .catch((error) => {
        observeStartup('fatal', fatalResults(error));
        failStartup(runtime, error);
    });
}
/** Create the production-shaped kernel/coordinator pair and start its bridge. */
export function bootstrapApplication(composition, channels) {
    const kernel = new LifecycleKernel(composition.kernelDependencies);
    const quitCoordinator = new QuitCoordinator({
        ...composition.quitDependencies,
        kernel,
    });
    startApplicationBootstrap({
        app: composition.app,
        ipcMain: composition.ipcMain,
        registerModules: () => {
            const lifecycleDependencies = composition.createLifecycleDependencies({
                kernel,
                quitCoordinator,
            });
            registerApplicationLifecycleModules(kernel, lifecycleDependencies);
        },
        runBeforeReady: () => {
            return kernel.runBeforeReady();
        },
        runWhenReady: () => kernel.runWhenReady(),
        shouldContinueStartup: () => kernel.state === 'starting',
        onReady: composition.onReady,
        onBeforeQuit: (event) => quitCoordinator.onBeforeQuit(event),
        onWillQuit: (event) => quitCoordinator.onWillQuit(event),
        onRendererQuitConfirmed: () => quitCoordinator.confirmRendererQuit(),
        onBringToFront: composition.onBringToFront,
        failStartup: (error) => quitCoordinator.failStartup(error),
        now: composition.kernelDependencies.now,
        observeStartup: composition.observeStartup,
    }, channels);
    return { kernel, quitCoordinator };
}
