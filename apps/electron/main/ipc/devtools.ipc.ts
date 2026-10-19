import { BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { IPC_CHANNELS } from "../config/constants";
import { getDeveloperOptions, onDeveloperOptionsChanged, setDeveloperOptions } from "../modules/developer-options";
import { resolveLocalRuntimeDataDir } from "../modules/local-runtime/data-dir";
import { resolveLocalRuntimeV2DirectoryContract } from "../modules/local-runtime/v2-paths";
import { getUtilityRuntimeMemoryMonitorState, setUtilityRuntimeMemoryRecording, clearUtilityRuntimeMemorySamples, startUtilityRuntimeHeapSampling, stopUtilityRuntimeHeapSampling } from "../modules/local-runtime/utility";
let unsubscribeDeveloperOptions;
function broadcastDeveloperOptions(state) {
    for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
            window.webContents.send(IPC_CHANNELS.DEVELOPER_OPTIONS_CHANGED, state);
        }
    }
}
function assertRuntimeMemoryMonitorAvailable() {
    const developerOptions = getDeveloperOptions();
    if (!developerOptions.available || !developerOptions.enabled) {
        throw new Error('runtime memory monitor is unavailable');
    }
}
function isOwnedRuntimeHeapProfile(profilePath) {
    const profileDirectory = path.resolve(resolveLocalRuntimeV2DirectoryContract(resolveLocalRuntimeDataDir()).diagnostics, 'heap-profiles');
    const resolvedProfile = path.resolve(profilePath);
    const relative = path.relative(profileDirectory, resolvedProfile);
    return (relative.length > 0 &&
        !relative.startsWith(`..${path.sep}`) &&
        relative !== '..' &&
        !path.isAbsolute(relative) &&
        resolvedProfile.endsWith('.heapprofile'));
}
export function setupDevToolsIPC() {
    ipcMain.handle(IPC_CHANNELS.DEVELOPER_OPTIONS_GET, () => getDeveloperOptions());
    unsubscribeDeveloperOptions?.();
    unsubscribeDeveloperOptions = onDeveloperOptionsChanged(broadcastDeveloperOptions);
    for (const channel of [IPC_CHANNELS.DEVTOOLS_OPEN, IPC_CHANNELS.DEVTOOLS_TOGGLE]) {
        ipcMain.handle(channel, (event) => {
            if (!getDeveloperOptions().available) {
                return { success: false, error: 'unsupported_environment' };
            }
            const webContents = event.sender;
            if (webContents.isDestroyed()) {
                return { success: false, error: 'window_unavailable' };
            }
            try {
                if (channel === IPC_CHANNELS.DEVTOOLS_TOGGLE && webContents.isDevToolsOpened()) {
                    webContents.closeDevTools();
                    setDeveloperOptions({ autoOpenNativeDevTools: false });
                }
                else {
                    webContents.openDevTools({ mode: 'right', activate: true });
                }
                return { success: true };
            }
            catch (error) {
                return { success: false, error: String(error) };
            }
        });
    }
    ipcMain.handle(IPC_CHANNELS.RUNTIME_MEMORY_MONITOR_GET, () => {
        assertRuntimeMemoryMonitorAvailable();
        return getUtilityRuntimeMemoryMonitorState();
    });
    ipcMain.handle(IPC_CHANNELS.RUNTIME_MEMORY_MONITOR_SET_RECORDING, (_event, enabled, intervalMs) => {
        assertRuntimeMemoryMonitorAvailable();
        return setUtilityRuntimeMemoryRecording(enabled, intervalMs);
    });
    ipcMain.handle(IPC_CHANNELS.RUNTIME_MEMORY_MONITOR_CLEAR, () => {
        assertRuntimeMemoryMonitorAvailable();
        return clearUtilityRuntimeMemorySamples();
    });
    ipcMain.handle(IPC_CHANNELS.RUNTIME_MEMORY_MONITOR_START_HEAP_SAMPLING, () => {
        assertRuntimeMemoryMonitorAvailable();
        return startUtilityRuntimeHeapSampling();
    });
    ipcMain.handle(IPC_CHANNELS.RUNTIME_MEMORY_MONITOR_STOP_HEAP_SAMPLING, () => {
        assertRuntimeMemoryMonitorAvailable();
        return stopUtilityRuntimeHeapSampling();
    });
    ipcMain.handle(IPC_CHANNELS.RUNTIME_MEMORY_MONITOR_REVEAL_PROFILE, () => {
        assertRuntimeMemoryMonitorAvailable();
        const profilePath = getUtilityRuntimeMemoryMonitorState().lastProfile?.profilePath;
        if (!profilePath || !isOwnedRuntimeHeapProfile(profilePath)) {
            return { success: false, error: 'profile_unavailable' };
        }
        shell.showItemInFolder(profilePath);
        return { success: true };
    });
}
