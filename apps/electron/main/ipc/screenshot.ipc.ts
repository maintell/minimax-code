import { BrowserWindow, ipcMain, shell } from "electron";
import { startCaptureMeasurement } from "../modules/screenshot/capture-analytics";
import { mkdir } from "node:fs/promises";
import { cleanCaptureCache, captureStorageRoot } from "../modules/screenshot/capture-storage";
import { getIsEn } from "../utils/tool";
import logger from "../utils/logger";
import { IPC_CHANNELS } from "../config/constants";
import { openScreenCaptureSettings, ensureScreenCapturePermission } from "../modules/screenshot/capture-permission";
import { startCaptureSession } from "../modules/screenshot/capture-session";
import { getArchonMiniChatWindow, runWhileKeepingMiniChatVisible } from "../windows/archonMiniChatWindow";
import { windowManager } from "../windows";
function trustedWindow(event) {
    const main = windowManager.getWindowByType('archon');
    const mini = getArchonMiniChatWindow();
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win ||
        win.isDestroyed() ||
        (win !== main && win !== mini) ||
        event.senderFrame !== event.sender.mainFrame)
        throw new Error('Unauthorized screenshot caller');
    return win;
}
function parseCaptureRegion(value) {
    if (!value || typeof value !== 'object')
        return null;
    const { x, y, width, height } = value;
    if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0)
        return null;
    return {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
    };
}
let busy = false;
export function setupScreenshotIPC() {
    void cleanCaptureCache().catch((error) => logger.error('[Screenshot] Cache cleanup failed:', error));
    ipcMain.handle(IPC_CHANNELS.SCREENSHOT_MANAGE_STORAGE, async (event, action) => {
        trustedWindow(event);
        if (action === 'open') {
            const directory = captureStorageRoot();
            await mkdir(directory, { recursive: true, mode: 0o700 });
            const error = await shell.openPath(directory);
            if (error)
                throw new Error(error);
        }
        else if (action === 'clear-cache') {
            if (busy)
                return 'busy';
            await cleanCaptureCache(true);
        }
        else
            throw new Error('Invalid capture storage action');
    });
    ipcMain.handle(IPC_CHANNELS.SCREENSHOT_CAPTURE_PAGE_REGION, async (event, value) => {
        // The recorder in login and onboarding may capture its own page.
        const target = BrowserWindow.fromWebContents(event.sender);
        if (!target ||
            target.isDestroyed() ||
            event.sender !== target.webContents ||
            event.senderFrame !== event.sender.mainFrame ||
            (!windowManager.getTypeByWindowId(target.id) && target !== getArchonMiniChatWindow()))
            throw new Error('Unauthorized screenshot caller');
        const rect = parseCaptureRegion(value);
        if (!rect)
            throw new Error('Invalid capture region');
        const image = await target.webContents.capturePage(rect);
        if (image.isEmpty())
            throw new Error('Captured image is empty');
        return image.toDataURL();
    });
    ipcMain.handle(IPC_CHANNELS.SCREENSHOT_OPEN_PERMISSION_SETTINGS, async (event) => {
        trustedWindow(event);
        await openScreenCaptureSettings();
    });
    ipcMain.handle(IPC_CHANNELS.SCREENSHOT_START, async (event, entry = 'button') => {
        let report;
        let mode = 'unknown';
        let acquired = false;
        try {
            const owner = trustedWindow(event);
            if (busy)
                return { success: false, errorType: 'busy' };
            busy = true;
            acquired = true;
            report = startCaptureMeasurement(entry, owner === getArchonMiniChatWindow() ? 'mini_chat' : 'main');
            // Mini Chat hides on blur; keep it while macOS shows its authorization prompt.
            return await runWhileKeepingMiniChatVisible(owner, async () => {
                const permission = await ensureScreenCapturePermission(owner);
                // The composer explains a missing permission with the shared permission dialog.
                if (permission !== 'granted') {
                    report?.(permission, mode);
                    return {
                        success: false,
                        errorType: 'permission',
                        permissionStatus: permission,
                        error: 'Screen recording permission is not granted',
                    };
                }
                // Keep the desktop intact: only the capture overlay controls its own visibility.
                const result = await startCaptureSession(event.sender, getIsEn() ? 'en' : 'zh', (value) => {
                    mode = value;
                });
                if (mode === 'unknown')
                    mode = result.mimeType === 'video/mp4' ? 'record' : 'image';
                report?.('success', mode);
                // PNG bytes are already in the clipboard; recordings stay as permanent files.
                if (result.mimeType === 'video/mp4')
                    shell.showItemInFolder(result.filePath);
                await cleanCaptureCache().catch((error) => logger.error('[Screenshot] Cache cleanup failed:', error));
                return { success: true, ...result };
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const cancelled = /cancelled|canceled/i.test(message);
            report?.(error instanceof Error && error.name === 'CaptureInterruptedError'
                ? 'interrupted'
                : cancelled
                    ? 'cancelled'
                    : 'error', mode);
            if (!cancelled)
                logger.error('[Screenshot] Capture failed:', message);
            return {
                success: false,
                error: message,
                errorType: cancelled ? 'cancelled' : 'error',
            };
        }
        finally {
            if (acquired) {
                busy = false;
            }
        }
    });
}
