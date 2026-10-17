import { join } from "node:path";
import { app, ipcMain, BrowserWindow, shell } from "electron";
import { isTrackingRecorderBuild, IPC_CHANNELS } from "../config";
import { TrackingRecorderService, resolveTrackingRecorderGitMetadata } from "../modules/tracking-recorder/service";
import { getDeveloperOptions } from "../modules/developer-options";
const MAX_SCREENSHOT_IDS = 30;
export function setupTrackingRecorderIPC(options = {}) {
    if (!isTrackingRecorderBuild)
        return;
    const service = options.service ??
        new TrackingRecorderService({
            exportRoot: join(app.getPath('documents'), 'MiniMax Code Tracking Records'),
            resolveGitMetadata: () => resolveTrackingRecorderGitMetadata(app.getAppPath()),
        });
    ipcMain.handle(IPC_CHANNELS.TRACKING_RECORDER_REGISTER_SCREENSHOT, async (_event, value) => {
        assertTrackingRecorderEnabled();
        if (typeof value !== 'string')
            throw new Error('Invalid tracking screenshot payload');
        return service.registerScreenshot(value);
    });
    ipcMain.handle(IPC_CHANNELS.TRACKING_RECORDER_READ_SCREENSHOT, async (_event, value) => {
        assertTrackingRecorderEnabled();
        if (typeof value !== 'string')
            throw new Error('Invalid tracking screenshot id');
        return service.readScreenshot(value);
    });
    ipcMain.handle(IPC_CHANNELS.TRACKING_RECORDER_AVAILABLE_SCREENSHOTS, async (_event, value) => {
        assertTrackingRecorderEnabled();
        return service.availableScreenshotIds(parseScreenshotIds(value));
    });
    ipcMain.handle(IPC_CHANNELS.TRACKING_RECORDER_RELEASE_SCREENSHOTS, async (_event, value) => {
        assertTrackingRecorderEnabled();
        service.releaseScreenshots(parseScreenshotIds(value));
    });
    ipcMain.handle(IPC_CHANNELS.TRACKING_RECORDER_RELOAD_RENDERER, async (event) => {
        assertTrackingRecorderEnabled();
        const owner = BrowserWindow.fromWebContents(event.sender);
        if (!owner || owner.isDestroyed())
            throw new Error('No requesting renderer window');
        owner.webContents.reloadIgnoringCache();
    });
    ipcMain.handle(IPC_CHANNELS.TRACKING_RECORDER_EXPORT_DIRECTORY, async (_event, value) => {
        assertTrackingRecorderEnabled();
        const result = await service.exportDirectory(value);
        const openError = await shell.openPath(result.folderPath);
        if (openError)
            throw new Error(openError);
        return result;
    });
}
function assertTrackingRecorderEnabled() {
    if (!getDeveloperOptions().enabled)
        throw new Error('Developer features are disabled');
}
function parseScreenshotIds(value) {
    if (!Array.isArray(value) ||
        value.length > MAX_SCREENSHOT_IDS ||
        !value.every((item) => typeof item === 'string' && item.length > 0)) {
        throw new Error('Invalid tracking screenshot ids');
    }
    return value;
}
