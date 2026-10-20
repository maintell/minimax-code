/**
 * 桌面设置 IPC 处理
 * 处理托盘、开机自启动、全局快捷键、通知等设置
 *
 */
import os from "os";
import path from "path";
import { app, globalShortcut, BrowserWindow, shell, ipcMain } from "electron";
import { createTray, getTray, destroyTray } from "../modules/tray";
import { toggleArchonMiniChatWindow } from "../windows";
import { windowManager } from "../windows/manager";
import { SHORTCUT_KEYS, IPC_CHANNELS } from "../config/constants";
import logger from "../utils/logger";
import { requestRendererRelaunch } from "../lifecycle/application-bootstrap";
import { getDesktopConfig, setDesktopConfig } from "./storage.ipc";
import { startPowerSourceMonitoring, setKeepAwakeEnabled } from "../modules/power";
import { ensureComputerUseUtilityStarted, stopLocalRuntime, prepareLocalRuntime } from "../modules/local-runtime";
import { getLocalRuntimeDataDirInfo, relocateLocalRuntimeDataDir, LocalRuntimeDataDirRelocationError } from "../modules/local-runtime/data-dir-relocation";
let localRuntimeDataDirRelocationInProgress = false;
function createTrayWithLifecycleQuit(options) {
    createTray({
        onQuit: () => {
            if (options.requestQuit) {
                void options.requestQuit({ kind: 'normal', source: 'tray-menu' });
                return;
            }
            app.quit();
        },
    });
}
/**
 * 注册所有全局快捷键
 * 这是全局快捷键，即使应用不在前台也能触发
 * globalAccessShortcut 格式: { miniChatCreate: 'Alt+A' } (功能名 → 快捷键)
 * 注意：调用前需要先调用 unregisterGlobalShortcuts() 取消旧的快捷键
 */
export function registerGlobalShortcuts() {
    const config = getDesktopConfig();
    if (config.shortcutsEnabled === false)
        return true;
    const globalAccessShortcut = config.globalAccessShortcut || {};
    const windowType = windowManager.getWindowType();
    let allSuccess = true;
    const miniChatShortcut = globalAccessShortcut[SHORTCUT_KEYS.MINI_CHAT_CREATE];
    if (miniChatShortcut) {
        const callback = toggleArchonMiniChatWindow;
        const registered = globalShortcut.register(miniChatShortcut, callback);
        if (!registered) {
            console.error(`[Desktop Settings] Failed to register MiniChat shortcut: ${miniChatShortcut}`);
            allSuccess = false;
        }
        else {
            logger.info(`[Desktop Settings] Registered MiniChat shortcut: ${miniChatShortcut} (${windowType} mode)`);
        }
    }
    // 如果需要注册更多快捷键，可以在这里添加
    return allSuccess;
}
/**
 * 取消注册所有全局快捷键
 *
 * 跳过空字符串：renderer 端发送空 shortcut 表示"禁用",该 key 在写入前
 * 会被 delete 掉，但旧版本配置可能残留 ''，Electron globalShortcut.isRegistered('')
 * 行为未定义,显式跳过更稳。
 */
export function unregisterGlobalShortcuts() {
    const globalAccessShortcut = getDesktopConfig().globalAccessShortcut || {};
    // 遍历所有配置的快捷键值并取消注册
    Object.values(globalAccessShortcut).forEach((shortcutKey) => {
        if (!shortcutKey)
            return;
        try {
            if (globalShortcut.isRegistered(shortcutKey)) {
                globalShortcut.unregister(shortcutKey);
                logger.info(`[Desktop Settings] Unregistered shortcut: ${shortcutKey}`);
            }
        }
        catch (error) {
            console.error(`[Desktop Settings] Failed to unregister shortcut ${shortcutKey}:`, error);
        }
    });
}
function unregisterShortcut(shortcut) {
    if (!shortcut)
        return;
    try {
        if (globalShortcut.isRegistered(shortcut)) {
            globalShortcut.unregister(shortcut);
            logger.info(`[Desktop Settings] Unregistered shortcut: ${shortcut}`);
        }
    }
    catch (error) {
        console.error(`[Desktop Settings] Failed to unregister shortcut ${shortcut}:`, error);
    }
}
function registerMiniChatShortcut(shortcut) {
    if (!shortcut)
        return true;
    try {
        const registered = globalShortcut.register(shortcut, toggleArchonMiniChatWindow);
        if (!registered) {
            console.error(`[Desktop Settings] Failed to register MiniChat shortcut: ${shortcut}`);
        }
        return registered;
    }
    catch (error) {
        console.error(`[Desktop Settings] Failed to register MiniChat shortcut: ${shortcut}`, error);
        return false;
    }
}
/**
 * Per-binding overrides store arrays; legacy values are plain strings. The
 * OS-level globalShortcut for Mini Chat stays a single key on purpose — we
 * register only the first binding instead of multi-registering, so the
 * global-shortcut surface keeps its one-key behavior.
 */
function firstOverrideBinding(value) {
    if (Array.isArray(value)) {
        return value.find((entry) => typeof entry === 'string' && entry.length > 0) ?? null;
    }
    return value || null;
}
export function applyShortcutOverrides(overrides, enabled) {
    const currentConfig = getDesktopConfig();
    const nextEnabled = enabled ?? currentConfig.shortcutsEnabled !== false;
    const previousOverrides = currentConfig.shortcutOverrides || {};
    const previousGlobalAccess = currentConfig.globalAccessShortcut || {};
    const previousMiniChat = currentConfig.shortcutsEnabled === false
        ? null
        : previousGlobalAccess[SHORTCUT_KEYS.MINI_CHAT_CREATE] || null;
    const nextMiniChat = nextEnabled
        ? firstOverrideBinding(overrides[SHORTCUT_KEYS.MINI_CHAT_TOGGLE])
        : null;
    if (previousMiniChat !== nextMiniChat) {
        unregisterShortcut(previousMiniChat);
        if (!registerMiniChatShortcut(nextMiniChat)) {
            registerMiniChatShortcut(previousMiniChat);
            return {
                success: false,
                error: 'global_registration_failed',
                overrides: previousOverrides,
            };
        }
    }
    const nextGlobalAccess = { ...previousGlobalAccess };
    if (nextMiniChat) {
        nextGlobalAccess[SHORTCUT_KEYS.MINI_CHAT_CREATE] = nextMiniChat;
    }
    else {
        delete nextGlobalAccess[SHORTCUT_KEYS.MINI_CHAT_CREATE];
    }
    setDesktopConfig({
        shortcutOverrides: overrides,
        shortcutsEnabled: nextEnabled,
        globalAccessShortcut: nextGlobalAccess,
    });
    for (const window of BrowserWindow.getAllWindows()) {
        try {
            if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
                window.webContents.send(IPC_CHANNELS.DESKTOP_SHORTCUTS_CHANGED, {
                    overrides,
                    enabled: nextEnabled,
                });
            }
        }
        catch {
            // A closing renderer must not turn a committed preference into a failed save.
            logger.warn('[Desktop Settings] Could not notify a closing window of shortcut changes');
        }
    }
    return { success: true, overrides };
}
/**
 * 设置开机自启动
 */
function setLoginItemSettings(enabled) {
    app.setLoginItemSettings({
        // Unpackaged dev apps use a per-worktree bundle identity. Registering one
        // would leave a separate macOS login item for every worktree.
        openAtLogin: app.isPackaged && enabled,
        // macOS 专用：在登录时隐藏窗口
        openAsHidden: false,
    });
}
/**
 * 获取开机自启动状态
 */
function getLoginItemSettings() {
    if (!app.isPackaged)
        return false;
    const settings = app.getLoginItemSettings();
    return settings.openAtLogin;
}
export const openSystemNotificationSettings = () => {
    if (process.platform === 'darwin') {
        const release = os.release();
        const majorVersion = parseInt(release.split('.')[0]);
        if (majorVersion >= 22) {
            shell.openExternal(`x-apple.systempreferences:com.apple.Notifications-Settings.extension`);
        }
        else {
            shell.openExternal('x-apple.systempreferences:com.apple.preference.notifications');
        }
    }
    else if (process.platform === 'win32') {
        shell.openExternal('ms-settings:notifications');
    }
};

/**
 * 初始化桌面设置
 * 在应用启动时调用，根据保存的配置初始化各项功能
 */
export function initDesktopSettings(options = {}) {
    const config = getDesktopConfig();
    // 初始化托盘
    if (config.menuBarVisible !== false) {
        createTrayWithLifecycleQuit(options);
    }
    // 开发版不拥有系统登录项，并在启动时清理当前 worktree 的历史残留。
    if (!app.isPackaged) {
        try {
            setLoginItemSettings(false);
        }
        catch (error) {
            logger.warn('[Desktop Settings] Failed to remove development login item', error);
        }
    }
    else if (!config?.loginItemInitialized) {
        // 正式安装包仅首次运行时设置，后续由用户手动切换。
        setLoginItemSettings(config.runOnStartup !== false);
        setDesktopConfig({ loginItemInitialized: true });
    }
    // 初始化保持唤醒：先读取并监听 AC/电池状态，再恢复用户偏好。
    // 是否存在 RC producer binding 由 remote-control bridge 的状态订阅同步。
    startPowerSourceMonitoring();
    setKeepAwakeEnabled(!!config.keepAwake);
    // 全局快捷键（MiniChat 等）延迟到 AppWindow 打开时注册，
    // 由 WindowManager 的 windowConfig.main.onSwitch 触发。
}
/**
 * 设置桌面设置 IPC 处理器
 */
export function setupDesktopSettingsIPC(options = {}) {
    // 设置托盘可见性
    ipcMain.handle(IPC_CHANNELS.DESKTOP_SET_TRAY_VISIBLE, (_, visible) => {
        try {
            if (visible) {
                if (!getTray()) {
                    createTrayWithLifecycleQuit(options);
                }
            }
            else {
                destroyTray();
            }
            setDesktopConfig({ menuBarVisible: visible });
            return { success: true };
        }
        catch (error) {
            return { success: false, error: String(error) };
        }
    });
    // 获取托盘可见性
    ipcMain.handle(IPC_CHANNELS.DESKTOP_GET_TRAY_VISIBLE, () => {
        return !!getTray();
    });
    // 设置开机自启动
    ipcMain.handle(IPC_CHANNELS.DESKTOP_SET_RUN_ON_STARTUP, (_, enabled) => {
        try {
            setLoginItemSettings(enabled);
            if (app.isPackaged) {
                setDesktopConfig({ runOnStartup: enabled });
            }
            return { success: true };
        }
        catch (error) {
            return { success: false, error: String(error) };
        }
    });
    // 获取开机自启动状态
    ipcMain.handle(IPC_CHANNELS.DESKTOP_GET_RUN_ON_STARTUP, () => {
        return getLoginItemSettings();
    });
    // 保持唤醒（用户偏好）— mode 状态机会结合 RC、供电和 CU 状态选择 blocker type:
    //   keepAwake=true & RC=on & AC=on & CU=off → 'prevent-app-suspension'（屏幕可休眠）
    //   keepAwake=false / RC=off / AC=off & CU=off → 'off'
    //   CU=on → 'prevent-display-sleep'（CU 优先级高于用户偏好、RC 和供电状态）
    ipcMain.handle(IPC_CHANNELS.DESKTOP_SET_KEEP_AWAKE, (_, enabled) => {
        try {
            setKeepAwakeEnabled(enabled);
            setDesktopConfig({ keepAwake: enabled });
            return { success: true };
        }
        catch (error) {
            return { success: false, error: String(error) };
        }
    });
    // 返回用户对 keepAwake 的偏好（不是当前持有的 assertion type）；
    // RC binding 和供电状态只决定偏好当前是否生效，不覆盖已保存的用户选择。
    ipcMain.handle(IPC_CHANNELS.DESKTOP_GET_KEEP_AWAKE, () => {
        return !!getDesktopConfig().keepAwake;
    });
    ipcMain.handle(IPC_CHANNELS.DESKTOP_START_COMPUTER_USE_RUNTIME, async () => {
        try {
            const success = await ensureComputerUseUtilityStarted();
            return { success, ...(success ? {} : { error: 'computer_utility_unavailable' }) };
        }
        catch (error) {
            return { success: false, error: String(error) };
        }
    });
    // 快捷键设置
    ipcMain.handle(IPC_CHANNELS.DESKTOP_SET_GLOBAL_ACCESS_SHORTCUT, (_, globalAccessShortcut) => {
        try {
            const currentOverrides = getDesktopConfig().shortcutOverrides || {};
            const nextOverrides = {
                ...currentOverrides,
                [SHORTCUT_KEYS.MINI_CHAT_TOGGLE]: Object.prototype.hasOwnProperty.call(globalAccessShortcut, SHORTCUT_KEYS.MINI_CHAT_CREATE)
                    ? globalAccessShortcut[SHORTCUT_KEYS.MINI_CHAT_CREATE]
                    : null,
            };
            const result = applyShortcutOverrides(nextOverrides);
            return { success: result.success, error: result.error };
        }
        catch (error) {
            return { success: false, error: String(error) };
        }
    });
    // 获取快捷键状态（返回用户偏好设置）
    ipcMain.handle(IPC_CHANNELS.DESKTOP_GET_GLOBAL_ACCESS_SHORTCUT, () => {
        const config = getDesktopConfig();
        return config.globalAccessShortcut;
    });
    ipcMain.handle(IPC_CHANNELS.DESKTOP_SET_SHORTCUT_OVERRIDES, (_, overrides, enabled) => {
        try {
            if (enabled !== undefined && typeof enabled !== 'boolean') {
                throw new Error('Invalid shortcuts enabled state');
            }
            return applyShortcutOverrides(overrides, enabled);
        }
        catch (error) {
            return {
                success: false,
                error: String(error),
                overrides: getDesktopConfig().shortcutOverrides || {},
            };
        }
    });
    // 打开系统通知设置
    ipcMain.handle(IPC_CHANNELS.DESKTOP_OPEN_NOTIFICATION_SETTINGS, () => {
        (0, openSystemNotificationSettings)();
        return { success: true };
    });
    // 设置语言（需要重启生效）
    ipcMain.handle(IPC_CHANNELS.DESKTOP_SET_LANGUAGE, (_, language) => {
        if (language !== 'en' && language !== 'zh') {
            return { success: false, error: `Unsupported language: ${String(language)}` };
        }
        try {
            setDesktopConfig({ language });
            return { success: true, requiresRestart: true };
        }
        catch (error) {
            return { success: false, error: String(error) };
        }
    });
    ipcMain.handle(IPC_CHANNELS.DESKTOP_GET_LOCAL_RUNTIME_DATA_DIR_INFO, () => {
        const config = getDesktopConfig();
        return {
            success: true,
            ...getLocalRuntimeDataDirInfo(config),
        };
    });
    ipcMain.handle(IPC_CHANNELS.DESKTOP_RELOCATE_LOCAL_RUNTIME_DATA_DIR, async (_, parentDir) => {
        if (process.platform !== 'win32') {
            return {
                success: false,
                errorCode: 'WINDOWS_ONLY',
                error: 'Local runtime data directory changes are only supported on Windows',
            };
        }
        if (typeof parentDir !== 'string' || !parentDir.trim()) {
            return { success: false, errorCode: 'INVALID_PARENT', error: 'Invalid parent directory' };
        }
        if (localRuntimeDataDirRelocationInProgress) {
            return {
                success: false,
                errorCode: 'MIGRATION_FAILED',
                error: 'A data directory migration is already in progress',
            };
        }
        localRuntimeDataDirRelocationInProgress = true;
        try {
            const config = getDesktopConfig();
            const result = await relocateLocalRuntimeDataDir({
                targetParentDir: parentDir,
                appInstallDir: process.platform === 'win32' ? path.dirname(app.getPath('exe')) : undefined,
                previousParentDirs: Array.isArray(config.localRuntimePreviousDataParentDirs)
                    ? config.localRuntimePreviousDataParentDirs.filter((dir) => typeof dir === 'string')
                    : [],
                previousConfig: {
                    localRuntimeDataParentDir: config.localRuntimeDataParentDir,
                    localRuntimePreviousDataParentDirs: config.localRuntimePreviousDataParentDirs,
                },
                stopLocalRuntime: stopLocalRuntime,
                prepareLocalRuntime: prepareLocalRuntime,
                saveConfig: (patch) => {
                    setDesktopConfig(patch);
                },
                relaunch: async () => {
                    if (!options.requestQuit) {
                        throw new Error('requestQuit is required to relaunch after data directory relocation');
                    }
                    await requestRendererRelaunch({ requestQuit: options.requestQuit }, 'data-dir-relocation');
                },
            });
            return result;
        }
        catch (error) {
            logger.error(`[Desktop Settings] Failed to relocate local runtime data dir: ${String(error)}`);
            if (error instanceof LocalRuntimeDataDirRelocationError) {
                return { success: false, errorCode: error.code, error: error.message };
            }
            return { success: false, errorCode: 'MIGRATION_FAILED', error: String(error) };
        }
        finally {
            localRuntimeDataDirRelocationInProgress = false;
        }
    });
}
/**
 * 清理桌面设置（应用退出时调用）
 */
export function cleanupDesktopSettings() {
    unregisterGlobalShortcuts();
}
