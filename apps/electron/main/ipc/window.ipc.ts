/**
 * 窗口控制 IPC 处理
 */
import { ipcMain, shell, clipboard } from "electron";
import { classifyDesktopLoginError } from "@mavis/shared/desktop-login-diagnostics";
import { IPC_CHANNELS } from "../config/constants";
import { openExternalTarget } from "../utils/open-external-target";
import { openUrlInBrowser, locateNamedBrowser, launchNamedBrowser } from "../utils/open-url-in-browser";
import { recordMcodeBrowserInstallSource, isMcodeBrowserStoreUrl, readChromeExtensionStatus, prepareManualExtensionFolder } from "../utils/mcode-browser-extension";
import { resolveLocalRuntimeDataDir } from "../modules/local-runtime/data-dir";
import logger from "../utils/logger";
import { getMainWindow } from "../windows/mainWindow";
function getExternalUrlLogContext(url) {
    try {
        const { protocol, hostname, pathname } = new URL(url);
        return { protocol, hostname, pathname };
    }
    catch {
        return { urlType: 'relative_or_invalid' };
    }
}
// 记下是本构建引导用户安装的 Chrome 扩展，扩展说明页的「回到 MiniMax Code」据此唤起本构建
function noteMcodeBrowserInstallSource() {
    recordMcodeBrowserInstallSource().catch((error) => {
        logger.warn({ msg: '[WindowIPC] mcode-browser install source failed', error: String(error) });
    });
}
/**
 * 设置窗口控制 IPC 处理器
 */
export function setupWindowIPC() {
    // 最小化窗口
    ipcMain.handle(IPC_CHANNELS.WINDOW_MINIMIZE, () => {
        getMainWindow()?.minimize();
    });
    // 恢复窗口（从最小化状态恢复并聚焦）
    ipcMain.handle(IPC_CHANNELS.WINDOW_RESTORE, () => {
        const mainWindow = getMainWindow();
        if (mainWindow) {
            mainWindow.restore();
            mainWindow.focus();
        }
    });
    // 最大化/还原窗口
    ipcMain.handle(IPC_CHANNELS.WINDOW_MAXIMIZE, () => {
        const mainWindow = getMainWindow();
        if (mainWindow?.isMaximized()) {
            mainWindow.unmaximize();
        }
        else {
            mainWindow?.maximize();
        }
        return mainWindow?.isMaximized();
    });
    // 关闭窗口
    ipcMain.handle(IPC_CHANNELS.WINDOW_CLOSE, () => {
        getMainWindow()?.close();
    });
    // 检查窗口是否最大化（包括全屏状态）
    ipcMain.handle(IPC_CHANNELS.WINDOW_IS_MAXIMIZED, () => {
        const mainWindow = getMainWindow();
        // macOS 上点击绿色按钮是进入全屏，需要同时检查
        return mainWindow?.isMaximized();
    });
    // 检查窗口是否全屏
    ipcMain.handle(IPC_CHANNELS.WINDOW_IS_FULL_SCREEN, () => {
        const mainWindow = getMainWindow();
        return mainWindow?.isFullScreen();
    });
    // 打开外部链接
    ipcMain.handle(IPC_CHANNELS.OPEN_EXTERNAL, async (_, url) => {
        try {
            await openExternalTarget(url);
            logger.info({
                msg: '[WindowIPC] external target open resolved',
                ...getExternalUrlLogContext(url),
            });
            return { success: true };
        }
        catch (error) {
            const errorMessage = String(error);
            logger.error({
                msg: '[WindowIPC] external target open failed',
                ...getExternalUrlLogContext(url),
                error: errorMessage,
            });
            const diagnostics = classifyDesktopLoginError(error, 'browser_open_failed', process.platform);
            return {
                success: false,
                error: errorMessage,
                diagnostics,
                ...(diagnostics.errorCode === 'no_default_browser'
                    ? { errorCode: 'no_default_browser' }
                    : {}),
            };
        }
    });
    // 用指定浏览器打开链接（插件安装后的引导页）；浏览器未安装时只报告，不换浏览器
    ipcMain.handle(IPC_CHANNELS.OPEN_URL_IN_BROWSER, async (_, url, browser) => {
        if (isMcodeBrowserStoreUrl(url))
            noteMcodeBrowserInstallSource();
        const result = await openUrlInBrowser(url, browser);
        const context = typeof url === 'string' ? getExternalUrlLogContext(url) : {};
        if (result.success) {
            logger.info({ msg: '[WindowIPC] named browser open resolved', browser, ...context });
        }
        else {
            logger.warn({
                msg: '[WindowIPC] named browser open failed',
                browser,
                errorCode: result.errorCode,
                ...context,
            });
        }
        return result;
    });
    // mcode-browser：Chrome 扩展状态（已启用 / 已停用 / 未安装 / 没装 Chrome）
    ipcMain.handle(IPC_CHANNELS.MCODE_BROWSER_EXTENSION_STATUS, async () => {
        try {
            const status = await readChromeExtensionStatus(async () => Boolean(await locateNamedBrowser('chrome')));
            return { success: true, status };
        }
        catch (error) {
            logger.warn({
                msg: '[WindowIPC] mcode-browser extension status failed',
                error: String(error),
            });
            return { success: false, errorCode: 'read_failed' };
        }
    });
    // mcode-browser：把插件里的扩展复制到固定文件夹，并在文件管理器里选中它（手动安装时拖进 Chrome）
    ipcMain.handle(IPC_CHANNELS.MCODE_BROWSER_REVEAL_MANUAL_EXTENSION, async () => {
        noteMcodeBrowserInstallSource();
        const result = await prepareManualExtensionFolder(resolveLocalRuntimeDataDir());
        if (!result.success) {
            logger.warn({
                msg: '[WindowIPC] mcode-browser manual extension failed',
                errorCode: result.errorCode,
            });
            return result;
        }
        shell.showItemInFolder(result.path);
        return { success: true };
    });
    // mcode-browser：Chrome 不接受从外部打开 chrome:// 页面，先复制地址再启动 Chrome，由用户粘贴
    ipcMain.handle(IPC_CHANNELS.MCODE_BROWSER_OPEN_CHROME_EXTENSIONS, async () => {
        clipboard.writeText('chrome://extensions');
        const result = await launchNamedBrowser('chrome');
        if (!result.success) {
            logger.warn({ msg: '[WindowIPC] chrome launch failed', errorCode: result.errorCode });
        }
        return result;
    });
}
