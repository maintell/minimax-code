/**
 * Archon Chat Window
 * The new default primary window after login.
 * Loads the /archon-chat Next.js page (single-tab architecture).
 * Managed by WindowManager as type 'archon', same level as 'main'.
 */
import * as path from "path";
import { shell } from "electron";
import { MAIN_WINDOW_WIDTH, MAIN_WINDOW_HEIGHT, MAIN_WINDOW_MIN_WIDTH, MAIN_WINDOW_MIN_HEIGHT, isDev, PAGE_URLS, IPC_CHANNELS } from "../config";
import { waitForServer } from "../utils";
import { waitForLocalRuntime, getLocalRuntimeFailReason } from "../modules/local-runtime";
import { getDeviceInfo } from "../utils/device-info";
import { abortAllStreams } from "../modules/protocol";
import { setupArchonMenu } from "../modules/menu";
import { getDeveloperOptions } from "../modules/developer-options";
import logger from "../utils/logger";
import { getTitleBarStyle, getBackgroundColor, ARCHON_MACOS_TRAFFIC_LIGHT_POSITION, DEFAULT_SECURE_WEB_PREFERENCES, shouldDenyWindowOpen } from "./utils";
import { recordElectronStartupMainMilestone } from "../modules/observability/startup-performance";
import { readMainWindowStartupState, attachMainWindowStatePersistence } from "../modules/window-state";
import { createDesktopRendererWindow } from "./desktopRendererWindow";
import { WINDOWS_TITLEBAR_HEIGHT, installWindowsTitlebar } from "./windows-titlebar";
let primaryRendererIncidentHandler;
/** Register the lifecycle-owned observer for every primary Archon renderer. */
export function setPrimaryRendererIncidentHandler(handler) {
    primaryRendererIncidentHandler = handler;
}
/**
 * Create Archon Chat window (managed by WindowManager)
 */
export async function createArchonChatWindow(context) {
    const isMac = process.platform === 'darwin';
    // 恢复上次退出时的窗口几何；存档缺失或已越界时回落到默认尺寸并由系统居中。
    const startupState = readMainWindowStartupState();
    const window = createDesktopRendererWindow('main', {
        width: startupState.bounds?.width ?? MAIN_WINDOW_WIDTH,
        height: startupState.bounds?.height ?? MAIN_WINDOW_HEIGHT,
        ...(startupState.bounds ? { x: startupState.bounds.x, y: startupState.bounds.y } : {}),
        minWidth: MAIN_WINDOW_MIN_WIDTH,
        minHeight: MAIN_WINDOW_MIN_HEIGHT,
        resizable: true,
        title: 'MiniMax Code',
        autoHideMenuBar: !isMac,
        titleBarStyle: process.platform === 'win32' ? 'hidden' : getTitleBarStyle(process.platform),
        ...(process.platform === 'win32'
            ? {
                titleBarOverlay: { height: WINDOWS_TITLEBAR_HEIGHT, color: getBackgroundColor() },
            }
            : {}),
        trafficLightPosition: isMac ? ARCHON_MACOS_TRAFFIC_LIGHT_POSITION : undefined,
        backgroundColor: getBackgroundColor(),
        webPreferences: {
            ...DEFAULT_SECURE_WEB_PREFERENCES,
            scrollBounce: isMac,
            preload: path.join(__dirname, '..', 'preload.js'),
        },
        show: false,
    });
    recordElectronStartupMainMilestone('browser_window_created');
    context.setWindow(window);
    installWindowsTitlebar(window);
    context.setWindowType('archon');
    attachMainWindowStatePersistence(window);
    primaryRendererIncidentHandler?.(window);
    // Production: daemon API proxy handled by app:// protocol handler (modules/protocol)
    // Dev mode: Next.js rewrites in next.config.js forward /mavis/* → 127.0.0.1:15321
    // Show window when ready
    window.once('ready-to-show', () => {
        // 先还原最大化再 show，避免窗口先以常态尺寸闪现一帧。
        if (startupState.maximized) {
            window?.maximize();
        }
        window?.show();
        window?.focus();
    });
    // Handle load failure with retry in dev mode
    window.webContents.on('did-fail-load', async (_event, errorCode, errorDescription, validatedURL) => {
        console.error(`[ArchonChat] Failed to load: ${validatedURL}, Error: ${errorDescription} (${errorCode})`);
        if (isDev && errorCode !== -3) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            context.getWindow()?.loadURL(getArchonPageUrl());
        }
    });
    // Kill zombie SSE connections on Cmd+R / navigation.
    // Electron's protocol.handle does not reliably fire request.signal on
    // renderer reload, so orphaned net.fetch() SSE streams survive.
    // Aborting them here frees the HTTP/1.1 connection pool slots.
    window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) {
            abortAllStreams();
        }
    });
    // Check for --target-url command-line parameter
    const targetUrlArg = process.argv.find((arg) => arg.startsWith('--target-url='));
    const targetUrl = targetUrlArg ? targetUrlArg.replace('--target-url=', '') : null;
    const getArchonPageUrl = () => {
        if (targetUrl) {
            const encodedTargetUrl = encodeURIComponent(targetUrl);
            return `${PAGE_URLS.ARCHON_CHAT}?initialUrl=${encodedTargetUrl}`;
        }
        return PAGE_URLS.ARCHON_CHAT;
    };
    waitForLocalRuntime().then((healthy) => {
        if (window?.isDestroyed?.())
            return;
        if (healthy) {
            window?.webContents?.send?.(IPC_CHANNELS.RUNTIME_READY);
        }
        else {
            const reason = getLocalRuntimeFailReason();
            const payload = {
                ...(reason ?? {}),
                deviceInfo: getDeviceInfo(),
            };
            window?.webContents?.send?.(IPC_CHANNELS.RUNTIME_FAILED, payload);
        }
    });
    // Load the Archon Chat page immediately (don't block on local runtime)
    if (isDev) {
        const serverReady = await waitForServer(PAGE_URLS.ARCHON_CHAT);
        if (serverReady) {
            recordElectronStartupMainMilestone('next_server_ready');
            await new Promise((resolve) => setTimeout(resolve, 500));
            recordElectronStartupMainMilestone('load_url_started');
            window.loadURL(getArchonPageUrl());
        }
        else {
            console.error('[ArchonChat] Failed to connect to Next.js server');
            return;
        }
    }
    else {
        recordElectronStartupMainMilestone('load_url_started');
        window.loadURL(getArchonPageUrl());
    }
    // Preserve the legacy opt-in after migrating it through the centralized
    // policy. The policy remains the security boundary for this startup path.
    window.webContents.once('did-finish-load', () => {
        const developerOptions = getDeveloperOptions();
        if (developerOptions.autoOpenNativeDevTools) {
            window.webContents.openDevTools({ mode: 'right', activate: true });
        }
    });
    window.webContents.on('before-input-event', (_event, input) => {
        // macOS can suppress the renderer DOM keyup for Command shortcuts. Forward
        // the native release so push-to-talk cannot leave the microphone running.
        if (input.type === 'keyUp') {
            window.webContents.send(IPC_CHANNELS.ASR_PUSH_TO_TALK_KEY_UP, {
                key: input.key,
                code: input.code,
            });
        }
    });
    // Open external links in default browser
    window.webContents.setWindowOpenHandler(({ url }) => {
        if (shouldDenyWindowOpen(url)) {
            shell.openExternal(url);
            return { action: 'deny' };
        }
        return { action: 'allow' };
    });
    // Close handler
    // - forceQuit (renderer confirmed / update installed) → close immediately
    // - App quitting (Cmd+Q / tray quit / quitAndInstall) → notify renderer, wait for confirm
    //   This IPC round-trip creates a natural delay for Squirrel.Mac to download the update zip.
    // - User clicks close button → hide to tray
    window.on('close', (event) => {
        if (context.isForceQuit()) {
            return;
        }
        event.preventDefault();
        if (context.isAppQuitting()) {
            if (!window.webContents.isDestroyed()) {
                logger.info('[ArchonChat] close: app quitting, notifying renderer before close');
                window.webContents.send(IPC_CHANNELS.APP_BEFORE_QUIT);
            }
        }
        else {
            logger.info('[ArchonChat] close: hiding window to tray');
            if (window.isFullScreen()) {
                window.once('leave-full-screen', () => {
                    window.hide();
                });
                window.setFullScreen(false);
            }
            else {
                window.hide();
            }
        }
    });
    // Monitor maximize/fullscreen state changes
    window.on('maximize', () => {
        context.getWindow()?.webContents.send(IPC_CHANNELS.WINDOW_MAXIMIZED_CHANGED, true);
    });
    window.on('unmaximize', () => {
        context.getWindow()?.webContents.send(IPC_CHANNELS.WINDOW_MAXIMIZED_CHANGED, false);
    });
    window.on('enter-full-screen', () => {
        context.getWindow()?.webContents.send(IPC_CHANNELS.WINDOW_FULL_SCREEN_CHANGED, true);
    });
    window.on('leave-full-screen', () => {
        context.getWindow()?.webContents.send(IPC_CHANNELS.WINDOW_FULL_SCREEN_CHANGED, false);
    });
    // Setup application menu (archon-specific: no tabs, no mini chat)
    setupArchonMenu();
}
