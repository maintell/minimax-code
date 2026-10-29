export let REQUIRED_LIFECYCLE_MODULES = Object.freeze([
    'protocol-scheme',
    'deep-link-single-instance',
    'dock-file-open',
    'observability',
    'native-crash-evidence',
    'power-save-blocker',
    'power-resume-recovery',
    'renderer-incident-recovery',
    'old-log-cleanup',
    'document-preview-protocol-handler',
    'production-protocol-handler',
    'ipc-updater',
    'local-runtime',
    'main-process-logs',
    'mcode-tools',
    'auth-bootstrap',
    'initial-window-activate',
    'local-runtime-warmup',
    'screenshots',
    'runtime-fetch-devtools',
    'desktop-settings',
    'hot-update-auto-check',
    'terminal-sessions',
]);
export function registerApplicationLifecycleModules(kernel, dependencies) {
    let authenticatedAtStartup = false;
    let stopSharedRuntimeAuthProjection;
    let registerActivateAfterDesktopSettings;
    let ipcHandle;
    const modules = [
        {
            name: 'protocol-scheme',
            phase: 'beforeReady',
            init: dependencies.registerProtocolScheme,
            onInitError: 'fatal',
        },
        {
            name: 'deep-link-single-instance',
            phase: 'beforeReady',
            init: dependencies.setupDeepLink,
            onInitError: 'fatal',
        },
        {
            name: 'dock-file-open',
            phase: 'beforeReady',
            init: dependencies.setupDockFileOpenHandler,
            onInitError: 'continue',
        },
        {
            name: 'observability',
            phase: 'beforeReady',
            init: () => {
                dependencies.setupObservabilityOutbox();
                dependencies.installObservabilityProbes();
            },
            onInitError: 'continue',
        },
        {
            name: 'native-crash-evidence',
            phase: 'beforeReady',
            init: dependencies.setupNativeCrashEvidence,
            onInitError: 'continue',
        },
        {
            name: 'power-save-blocker',
            phase: 'whenReady',
            init: () => undefined,
            onInitError: 'continue',
            dispose: dependencies.stopPowerSaveBlocker,
            disposeStage: 'pre',
        },
        {
            name: 'power-resume-recovery',
            phase: 'whenReady',
            init: dependencies.setupPowerResumeRecovery,
            onInitError: 'continue',
        },
        {
            name: 'renderer-incident-recovery',
            phase: 'whenReady',
            init: dependencies.setupRendererIncidentRecovery,
            onInitError: 'continue',
        },
        {
            name: 'old-log-cleanup',
            phase: 'whenReady',
            init: () => {
                const cleanup = dependencies.cleanupOldLogs();
                void Promise.resolve(cleanup).catch(() => undefined);
            },
            onInitError: 'continue',
        },
        {
            name: 'document-preview-protocol-handler',
            phase: 'whenReady',
            init: dependencies.setupDocumentPreviewProtocolHandler,
            onInitError: 'fatal',
        },
        {
            name: 'production-protocol-handler',
            phase: 'whenReady',
            init: () => {
                if (!dependencies.isDev || dependencies.runtimeTransportMode === 'protocol') {
                    dependencies.setupProtocolHandler();
                }
            },
            onInitError: 'fatal',
        },
        {
            name: 'ipc-updater',
            phase: 'whenReady',
            init: async () => {
                ipcHandle = await dependencies.setupAllIPC();
                dependencies.recordStartupMainMilestone?.('ipc_ready');
            },
            onInitError: 'fatal',
            beforeQuit: () => {
                try {
                    dependencies.cleanupPPTPreviewCache();
                }
                finally {
                    dependencies.disconnectRemoteControlBridgeBeforeQuit();
                }
            },
            dispose: () => ipcHandle?.shutdown(),
            disposeStage: 'parallel',
            disposeTimeoutMs: 15000,
        },
        {
            name: 'local-runtime',
            phase: 'whenReady',
            init: () => undefined,
            onInitError: 'continue',
            dispose: dependencies.stopLocalRuntime,
            disposeStage: 'parallel',
            disposeTimeoutMs: 15000,
        },
        {
            name: 'main-process-logs',
            phase: 'whenReady',
            init: () => undefined,
            onInitError: 'continue',
            dispose: dependencies.flushMainProcessLogs,
            disposeStage: 'parallel',
            disposeTimeoutMs: 5000,
        },
        {
            name: 'mcode-tools',
            phase: 'whenReady',
            init: dependencies.initializeMcodeToolsIntegration,
            onInitError: 'continue',
            dispose: dependencies.disposeMcodeToolsIntegration,
            disposeStage: 'parallel',
            disposeTimeoutMs: 3000,
        },
        {
            name: 'auth-bootstrap',
            phase: 'whenReady',
            init: async () => {
                stopSharedRuntimeAuthProjection = dependencies.watchSharedRuntimeAuthProjection();
                try {
                    authenticatedAtStartup = await dependencies.syncStoredLocalRuntimeAuthContext();
                }
                catch (error) {
                    dependencies.onAuthBootstrapFailed?.(error);
                }
                dependencies.recordStartupMainMilestone?.('auth_bootstrap_ready');
            },
            // Account availability must not prevent the first window. Keep watching
            // so a later successful login/renewal can restore the runtime projection.
            onInitError: 'continue',
            dispose: () => {
                stopSharedRuntimeAuthProjection?.();
                stopSharedRuntimeAuthProjection = undefined;
            },
            disposeStage: 'parallel',
            disposeTimeoutMs: 1000,
        },
        {
            name: 'initial-window-activate',
            phase: 'whenReady',
            init: () => {
                dependencies.recordStartupMainMilestone?.('initial_window_creation_started');
                void dependencies.createInitialWindow().then(dependencies.flushDockFileQueue);
                // This owner starts the window, but production registers activate only after fatal settings init.
                registerActivateAfterDesktopSettings = dependencies.registerActivateHandler;
            },
            onInitError: 'continue',
        },
        {
            name: 'local-runtime-warmup',
            phase: 'whenReady',
            init: () => {
                if (!authenticatedAtStartup)
                    return;
                void dependencies.prepareLocalRuntime().then((ready) => {
                    if (!ready)
                        dependencies.onLocalRuntimeWarmupFailed();
                });
            },
            onInitError: 'continue',
        },
        {
            name: 'screenshots',
            phase: 'whenReady',
            init: dependencies.initScreenshots,
            onInitError: 'continue',
        },
        {
            name: 'runtime-fetch-devtools',
            phase: 'whenReady',
            init: () => {
                if (dependencies.isDev ||
                    dependencies.isTest ||
                    dependencies.isStaging ||
                    dependencies.isInternalBuild) {
                    const initialize = dependencies.initRuntimeFetchDevTools();
                    if (initialize && typeof initialize.then === 'function') {
                        return Promise.resolve(initialize).then(() => {
                            dependencies.recordStartupMainMilestone?.('runtime_fetch_devtools_ready');
                        });
                    }
                    dependencies.recordStartupMainMilestone?.('runtime_fetch_devtools_ready');
                }
            },
            onInitError: 'continue',
        },
        {
            name: 'desktop-settings',
            phase: 'whenReady',
            init: () => {
                dependencies.initDesktopSettings();
                registerActivateAfterDesktopSettings?.();
                registerActivateAfterDesktopSettings = undefined;
            },
            onInitError: 'fatal',
            dispose: dependencies.cleanupDesktopSettings,
            disposeStage: 'pre',
        },
        {
            name: 'hot-update-auto-check',
            phase: 'whenReady',
            init: () => {
                if (!dependencies.isDev)
                    dependencies.startHotUpdateAutoCheck();
            },
            onInitError: 'continue',
            dispose: dependencies.stopHotUpdateAutoCheck,
            disposeStage: 'pre',
        },
        {
            name: 'terminal-sessions',
            phase: 'whenReady',
            init: () => undefined,
            onInitError: 'continue',
            dispose: dependencies.disposeTerminalSessions,
            disposeStage: 'pre',
        },
    ];
    for (const module of modules)
        kernel.register(module);
}
