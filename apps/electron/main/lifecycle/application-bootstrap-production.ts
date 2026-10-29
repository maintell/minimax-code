import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { readdir, lstat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { screen, powerMonitor, net, app, crashReporter, ipcMain, BrowserWindow, session } from "electron";
import { autoUpdater } from "electron-updater";
import { buildEnv, LOCALE, isDev, isTest, isStaging, isInternalBuild, isInsideBuild } from "../config";
import { DOMAIN_URL, IPC_CHANNELS } from "../config/constants";
import { setupAllIPC, initDesktopSettings, cleanupDesktopSettings, startHotUpdateAutoCheck, stopHotUpdateAutoCheck } from "../ipc";
import { cleanupPPTPreviewCache } from "../ipc/pptPreview.ipc";
import { handleCloudProtocolJsonRequest } from "../ipc/proxy.ipc";
import { getTokens, clearTokens, getDesktopConfig, replaceSharedUserInfo } from "../ipc/storage.ipc";
import { createDesktopAccountIdentitySource } from "../modules/auth/account-identity";
import { flushDockFileQueue, setupDockFileOpenHandler } from "../modules/dock";
import { setupDeepLink } from "../modules/deeplink";
import { clearGpuSentinel } from "../modules/gpu-guard";
import { handleLocalRuntimeRequest, configureLocalRuntimeAuthRecovery, stopLocalRuntime, prepareLocalRuntime } from "../modules/local-runtime";
import { recoverSharedRuntimeProjection, refreshSharedRuntimeProjection, watchSharedRuntimeProjection } from "../modules/auth/runtime-projection";
import { resolveLocalRuntimeDataDir } from "../modules/local-runtime/data-dir";
import { resolveRuntimeTransportMode } from "../modules/local-runtime/utility/transport-mode";
import { createDesktopAuthSession } from "../modules/auth";
import { createMainOwnedWorkspaceAuthority } from "../modules/document-preview/workspace-authority";
import { createMainOwnedAssetAuthority } from "../modules/document-preview/asset-authority";
import { createRuntimeFetchDevToolsInitializer } from "../modules/runtime-fetch-devtools";
import { initializeMcodeToolsIntegration, disposeMcodeToolsIntegration } from "../modules/mcode-tools";
import { disconnectRemoteControlBridgeBeforeQuit } from "../modules/remote-control-bridge/ipc";
import { markElectronObservabilityExpectedRendererExit, enqueueElectronObservabilityEvent, getElectronObservabilityAppInstanceId, setElectronObservabilityShuttingDown, setupElectronObservabilityOutbox, installElectronObservabilityProbes } from "../modules/observability/outbox";
import { recordElectronStartupMainMilestone } from "../modules/observability/startup-performance";
import { stopPowerSaveBlocker } from "../modules/power";
import { registerProtocolScheme, setupDocumentPreviewProtocolHandler, setupProtocolHandler } from "../modules/protocol";
import { initScreenshots } from "../modules/screenshot";
import { getTerminalManager } from "../modules/terminal";
import { resolveNormalUpdatePlan, resolveExplicitInstallPlan } from "../ipc/updater.ipc";
import { bringToFront } from "../utils";
import { showRendererIncidentDialog } from "../utils/renderer-incident-dialog";
import * as logger_1 from "../utils/logger";
import { windowManager } from "../windows";
import { configureInitialAuthResolver, resolveSharedOAuthAuthState } from "../windows/initial-auth";
import { setPrimaryRendererIncidentHandler } from "../windows/archonChatWindow";
import { requestRendererRelaunch, createActivateHandlerRegistrar, bootstrapApplication } from "./application-bootstrap";
import { CrashEvidence } from "./crash-evidence";
import { RendererIncidentController } from "./renderer-incident-controller";
import { createElectronTerminalActionAdapters } from "./quit-coordinator";
import { createElectronLifecycleTelemetry } from "./telemetry";
import { invalidateWorkspaceGitSnapshotsAfterResume } from "./workspace-git-resume";
import { confirmQuitWithRunningTasks } from "./quit-confirmation";
function logLifecycleError(message, error) {
    logger_1.default.error(error === undefined ? message : `${message}: ${String(error)}`);
}
function logLifecycleWarning(message, error) {
    logger_1.default.warn(error === undefined ? message : `${message}: ${String(error)}`);
}
function logPowerBreadcrumb(message) {
    try {
        logger_1.default.info(message);
    }
    catch {
        // Diagnostic breadcrumbs must not disrupt Electron power event delivery.
    }
}
function logDisplayInformation() {
    try {
        const primaryDisplay = screen.getPrimaryDisplay();
        const { width, height } = primaryDisplay.size;
        const allDisplays = screen.getAllDisplays();
        logger_1.default.info(`[Electron] Display: ${width}x${height} @${primaryDisplay.scaleFactor}x` +
            (allDisplays.length > 1 ? ` (${allDisplays.length} displays)` : ''));
    }
    catch (error) {
        logger_1.default.warn(`[Electron] Failed to get display info: ${String(error)}`);
    }
}
function createPowerResumeRecovery(controller) {
    return () => {
        powerMonitor.on('lock-screen', () => {
            logPowerBreadcrumb('[Power] Screen locked');
        });
        powerMonitor.on('unlock-screen', () => {
            logPowerBreadcrumb('[Power] Screen unlocked');
        });
        powerMonitor.on('suspend', () => {
            logPowerBreadcrumb('[Power] System suspended');
        });
        powerMonitor.on('resume', () => {
            logger_1.default.info('[Power] System resumed from sleep');
            void invalidateWorkspaceGitSnapshotsAfterResume(handleLocalRuntimeRequest).catch((error) => {
                logLifecycleWarning('[Power] Failed to invalidate Workspace Git snapshots', error);
            });
            const window = windowManager.getWindow();
            if (!window || window.isDestroyed() || window.webContents.isDestroyed())
                return;
            const isArchonWindow = windowManager.getWindowByType('archon') === window;
            const webContents = window.webContents;
            let settled = false;
            const reportFailure = (message) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(healthTimeout);
                logger_1.default.warn(message);
                if (isArchonWindow) {
                    void controller.reportResumeFailure(window);
                }
                else if (isWindowAlive(window)) {
                    webContents.reload();
                }
            };
            const healthTimeout = setTimeout(() => {
                reportFailure('[Power] Renderer unresponsive after resume');
            }, 8000);
            void webContents.executeJavaScript('Date.now()').then(() => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(healthTimeout);
                logger_1.default.info('[Power] Renderer responded after resume');
            }, () => reportFailure('[Power] Renderer ping failed after resume'));
        });
    };
}
function isWindowAlive(window) {
    const browserWindow = window;
    return !browserWindow.isDestroyed() && !browserWindow.webContents.isDestroyed();
}
function forceCrashRenderer(window) {
    const browserWindow = window;
    if (!isWindowAlive(window))
        return;
    markElectronObservabilityExpectedRendererExit(window.id);
    browserWindow.webContents.forcefullyCrashRenderer();
}
function normalizeDesktopAuthBuildEnv(value) {
    if (value === 'test' || value === 'staging' || value === 'prod')
        return value;
    return 'dev';
}
function createProductionComposition(options = {}) {
    const sharedAuthSession = createDesktopAuthSession({
        dataDir: resolveLocalRuntimeDataDir(),
        buildEnv: normalizeDesktopAuthBuildEnv(buildEnv),
        region: LOCALE === 'zh' ? 'cn' : 'en',
        endpointEnvironment: process.env,
        legacySource: {
            readAccessToken: () => getTokens().accessToken,
            clearAccessToken: clearTokens,
        },
        identitySource: createDesktopAccountIdentitySource({
            origin: DOMAIN_URL,
            language: LOCALE === 'zh' ? 'zh' : 'en',
            fetchImpl: (input, init) => net.fetch(input instanceof URL ? input.href : input, init),
            routingHeaders: () => {
                const lane = isDev || isTest || isStaging ? getDesktopConfig().swimLaneName?.trim() : undefined;
                return lane ? { lane, bedrock_lane: lane, 'bedrock-lane': lane } : {};
            },
            apply: (identity) => replaceSharedUserInfo({
                userID: identity.userID,
                realUserID: identity.realUserID,
                userMail: identity.userEmail,
                userName: identity.userName,
                subUserName: identity.subUserName,
            }),
        }),
    });
    configureInitialAuthResolver(() => resolveSharedOAuthAuthState(sharedAuthSession));
    configureLocalRuntimeAuthRecovery((rejectedAccessToken, loginEpoch) => recoverSharedRuntimeProjection(sharedAuthSession, rejectedAccessToken, loginEpoch));
    const runtimeTransportMode = resolveRuntimeTransportMode({
        argv: process.argv,
        env: process.env,
        buildEnv: buildEnv,
        isInternalBuild: isInternalBuild,
        isInsideBuild: isInsideBuild,
        warn: (message) => logger_1.default.warn(message),
    });
    const documentPreviewLogger = (0, logger_1.getCategoryLogger)('document-preview');
    const documentPreviewWorkspaceAuthority = createMainOwnedWorkspaceAuthority();
    const documentPreviewAssetAuthority = createMainOwnedAssetAuthority({
        logger: documentPreviewLogger,
    });
    const terminalActions = createElectronTerminalActionAdapters({ app: app, autoUpdater: autoUpdater });
    const lifecycleTelemetry = createElectronLifecycleTelemetry({
        enqueue: enqueueElectronObservabilityEvent,
    }, { info: (fields, message) => logger_1.default.info({ msg: message, ...fields }) });
    const crashEvidence = new CrashEvidence({
        crashReporter: crashReporter,
        isAppReady: () => app.isReady(),
        getCrashDumpsDirectory: () => app.getPath('crashDumps'),
        getSessionMarkerFilePath: () => join(app.getPath('userData'), 'crash-evidence-session.json'),
        appInstanceId: getElectronObservabilityAppInstanceId(),
        appVersion: app.getVersion(),
        now: () => Date.now(),
        enqueue: enqueueElectronObservabilityEvent,
        fileSystem: {
            readDirectory: (directoryPath) => readdir(directoryPath, { withFileTypes: true }),
            lstat: lstat,
            unlink: unlink,
            readTextFileSync: (filePath) => readFileSync(filePath, 'utf8'),
            writeTextFileSync: (filePath, contents) => writeFileSync(filePath, contents, 'utf8'),
            deleteFileSync: unlinkSync,
        },
        logger: {
            info: (data) => logger_1.default.info(data),
            warn: (data) => logger_1.default.warn(data),
        },
    });
    return {
        app: {
            on: ((eventName, listener) => app.on(eventName, listener)),
            whenReady: () => app.whenReady(),
        },
        ipcMain: {
            on: (channel, listener) => ipcMain.on(channel, (event, ...args) => listener(event, ...args)),
        },
        kernelDependencies: {
            logger: {
                error: logLifecycleError,
                warn: logLifecycleWarning,
            },
            now: () => Date.now(),
            setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
            clearTimeout: (timer) => clearTimeout(timer),
        },
        quitDependencies: {
            app: terminalActions.app,
            window: {
                hasLivePrimary: () => {
                    const window = windowManager.getWindowByType('archon');
                    return !!window && !window.isDestroyed();
                },
                setAppQuitting: (value) => {
                    setElectronObservabilityShuttingDown(value);
                    // The session marker must go before any teardown: death after this
                    // point is shutdown noise, not an unclean session.
                    if (value)
                        crashEvidence.recordQuitStarted();
                    windowManager.setAppQuitting(value);
                },
                setForceQuit: (value) => windowManager.setForceQuit(value),
                closePrimary: () => {
                    const window = windowManager.getWindowByType('archon');
                    if (window && !window.isDestroyed())
                        window.close();
                },
                destroyAll: () => {
                    for (const window of BrowserWindow.getAllWindows()) {
                        try {
                            if (!window.isDestroyed())
                                window.destroy();
                        }
                        catch (error) {
                            logLifecycleError('Failed to destroy a window during update shutdown', error);
                        }
                    }
                },
            },
            beforeQuit: clearGpuSentinel,
            confirmNormalQuit: () => confirmQuitWithRunningTasks(windowManager.getWindowByType('archon')),
            focusNormalQuitConfirmation: () => {
                const window = windowManager.getWindowByType('archon');
                if (!window || window.isDestroyed())
                    return;
                if (window.isMinimized())
                    window.restore();
                window.show();
                window.focus();
            },
            updater: {
                resolveNormalPlan: resolveNormalUpdatePlan,
                resolveExplicitInstallPlan: resolveExplicitInstallPlan,
                quitAndInstall: terminalActions.updater.quitAndInstall,
            },
            logger: {
                info: (fields, message) => logger_1.default.info({ msg: message, ...fields }),
                error: logLifecycleError,
                warn: logLifecycleWarning,
            },
            timers: {
                setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
                clearTimeout: (timer) => clearTimeout(timer),
            },
            flushLogs: logger_1.flushLogs,
            now: () => Date.now(),
            appInstanceId: getElectronObservabilityAppInstanceId(),
            observeShutdown: lifecycleTelemetry.observeShutdown,
            observeInstallerHandoff: lifecycleTelemetry.observeInstallerHandoff,
        },
        createLifecycleDependencies: ({ quitCoordinator }) => {
            const incidentController = new RendererIncidentController({
                now: () => Date.now(),
                isShuttingDown: () => windowManager.isAppQuitting(),
                isWindowAlive,
                observeIncident: (incident) => {
                    logger_1.default.error({
                        msg: '[RendererIncidentController] Primary renderer incident',
                        ...incident,
                    });
                },
                observeIncidentHandling: lifecycleTelemetry.observeRendererIncident,
                observeRecoveryResult: lifecycleTelemetry.observeRecoveryResult,
                reload: (window) => {
                    const browserWindow = window;
                    if (isWindowAlive(window))
                        browserWindow.webContents.reload();
                },
                forceCrash: forceCrashRenderer,
                showDialog: (request) => showRendererIncidentDialog({
                    parentWindow: request.window,
                    detail: [
                        `kind=${request.incident.kind}`,
                        `reason=${request.incident.reason}`,
                        request.incident.exitCode === undefined
                            ? undefined
                            : `exitCode=${request.incident.exitCode}`,
                    ]
                        .filter(Boolean)
                        .join('\n'),
                    onReload: request.onReload,
                    onRestart: request.onRestart,
                    findLatestCrashDump: () => crashEvidence.findLatestCrashDumpForIncident(request.incident.occurredAtMs),
                }),
                requestRelaunch: () => requestRendererRelaunch(quitCoordinator, 'renderer-incident-recovery'),
                logger: {
                    error: logLifecycleError,
                },
            });
            const registerActivateHandler = createActivateHandlerRegistrar(app, () => {
                if (BrowserWindow.getAllWindows().length === 0) {
                    void windowManager.createInitialWindow().then(() => flushDockFileQueue());
                }
                else {
                    bringToFront();
                    flushDockFileQueue();
                }
            });
            return {
                isDev: isDev,
                isTest: isTest,
                isStaging: isStaging,
                isInternalBuild: isInternalBuild,
                runtimeTransportMode,
                registerProtocolScheme: registerProtocolScheme,
                setupDeepLink: options.singleInstanceLockAlreadyAcquired
                    ? () => setupDeepLink(true)
                    : setupDeepLink,
                setupDockFileOpenHandler: () => setupDockFileOpenHandler(() => windowManager.getWindowByType('archon')),
                setupObservabilityOutbox: setupElectronObservabilityOutbox,
                installObservabilityProbes: () => installElectronObservabilityProbes({
                    onSystemSessionEnd: (evidence) => crashEvidence.recordSystemSessionEnd(evidence),
                }),
                setupNativeCrashEvidence: () => crashEvidence.startCrashEvidence(),
                stopPowerSaveBlocker: stopPowerSaveBlocker,
                setupPowerResumeRecovery: createPowerResumeRecovery(incidentController),
                setupRendererIncidentRecovery: () => {
                    setPrimaryRendererIncidentHandler((window) => incidentController.attach(window));
                    const existingWindow = windowManager.getWindowByType('archon');
                    if (existingWindow)
                        incidentController.attach(existingWindow);
                },
                cleanupOldLogs: logger_1.cleanupOldLogs,
                setupDocumentPreviewProtocolHandler: setupDocumentPreviewProtocolHandler,
                setupProtocolHandler: () => setupProtocolHandler({
                    ...(runtimeTransportMode === 'protocol'
                        ? { cloudJsonFetch: handleCloudProtocolJsonRequest }
                        : {}),
                }),
                setupAllIPC: () => setupAllIPC({
                    requestQuit: (intent) => quitCoordinator.requestQuit(intent),
                    runtimeTransportMode,
                    appVersion: app.getVersion(),
                    resolveTrustedWorkspace: documentPreviewWorkspaceAuthority.resolveTrustedWorkspace,
                    resolveTrustedWorkspaceCapability: documentPreviewWorkspaceAuthority.resolveTrustedWorkspaceCapability,
                    onDocumentPreviewSenderDestroyed: documentPreviewWorkspaceAuthority.releaseSender,
                    resolveTrustedAsset: documentPreviewAssetAuthority.resolve,
                    releaseTrustedAssetSender: documentPreviewAssetAuthority.releaseSender,
                    documentPreviewLogger,
                    sharedAuthSession,
                }),
                recordStartupMainMilestone: recordElectronStartupMainMilestone,
                disconnectRemoteControlBridgeBeforeQuit: disconnectRemoteControlBridgeBeforeQuit,
                cleanupPPTPreviewCache: cleanupPPTPreviewCache,
                stopLocalRuntime: async () => {
                    // App shutdown owns a global cutoff and may proceed while the old
                    // Utility remains quarantined. Data-dir relocation consumes the
                    // structured stop result directly and has stricter semantics.
                    await stopLocalRuntime();
                },
                flushMainProcessLogs: logger_1.flushLogs,
                initializeMcodeToolsIntegration: () => initializeMcodeToolsIntegration({ sharedAuthSession }),
                disposeMcodeToolsIntegration: disposeMcodeToolsIntegration,
                syncStoredLocalRuntimeAuthContext: () => refreshSharedRuntimeProjection(sharedAuthSession, {
                    allowAnonymous: true,
                }).then((lease) => Boolean(lease)),
                onAuthBootstrapFailed: (error) => logger_1.default.warn('[Auth] Startup auth projection unavailable; continuing to the window', error),
                watchSharedRuntimeAuthProjection: () => watchSharedRuntimeProjection(sharedAuthSession),
                prepareLocalRuntime: prepareLocalRuntime,
                onLocalRuntimeWarmupFailed: () => logger_1.default.warn('[LocalRuntime] Warmup after logged-in startup failed'),
                initScreenshots: initScreenshots,
                initRuntimeFetchDevTools: createRuntimeFetchDevToolsInitializer(session, {
                    warn: logLifecycleWarning,
                }),
                createInitialWindow: () => windowManager.createInitialWindow(),
                flushDockFileQueue: () => {
                    flushDockFileQueue();
                },
                registerActivateHandler,
                initDesktopSettings: () => initDesktopSettings({ requestQuit: (intent) => quitCoordinator.requestQuit(intent) }),
                cleanupDesktopSettings: cleanupDesktopSettings,
                startHotUpdateAutoCheck: startHotUpdateAutoCheck,
                stopHotUpdateAutoCheck: stopHotUpdateAutoCheck,
                disposeTerminalSessions: () => getTerminalManager().disposeAll(),
            };
        },
        onReady: () => {
            recordElectronStartupMainMilestone('app_ready');
            logDisplayInformation();
            app.once('browser-window-created', (_event, window) => {
                window.once('ready-to-show', () => clearGpuSentinel());
            });
        },
        onBringToFront: () => {
            logger_1.default.info('[App] bring-to-front: renderer requested');
            bringToFront({ createIfNotExists: false });
        },
        observeStartup: lifecycleTelemetry.observeStartup,
    };
}
export function bootstrapElectronApplication(options = {}) {
    return bootstrapApplication(createProductionComposition(options), {
        confirmQuitChannel: IPC_CHANNELS.APP_CONFIRM_QUIT,
        bringToFrontChannel: IPC_CHANNELS.APP_BRING_TO_FRONT,
    });
}
