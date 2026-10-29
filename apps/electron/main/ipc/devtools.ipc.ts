import { BrowserWindow, ipcMain, shell } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { IPC_CHANNELS } from "../config/constants";
import { getDeveloperOptions, onDeveloperOptionsChanged, setDeveloperOptions } from "../modules/developer-options";
import { resolveLocalRuntimeDataDir } from "../modules/local-runtime/data-dir";
import { resolveLocalRuntimeV2DirectoryContract } from "../modules/local-runtime/v2-paths";
import { getUtilityRuntimeMemoryMonitorState, setUtilityRuntimeMemoryRecording, clearUtilityRuntimeMemorySamples, startUtilityRuntimeHeapSampling, stopUtilityRuntimeHeapSampling } from "../modules/local-runtime/utility";
import { importEsm } from "../utils/import-esm";
/** Goal evidence window of a Developer Tools export, matching the log upload window. */
const GOAL_DIAGNOSTICS_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
const GOAL_DIAGNOSTICS_MAX_BYTES = 64 * 1024 * 1024;
let lastGoalDiagnosticsPath;
let unsubscribeDeveloperOptions;
function broadcastDeveloperOptions(state) {
    for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
            window.webContents.send(IPC_CHANNELS.DEVELOPER_OPTIONS_CHANGED, state);
        }
    }
}
/** Developer Tools IPC fails closed outside builds and sessions that enable them. */
function assertDeveloperToolsAvailable() {
    const developerOptions = getDeveloperOptions();
    if (!developerOptions.available || !developerOptions.enabled) {
        throw new Error('developer tools are unavailable');
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
/**
 * Write the consent-gated Goal diagnostic artifact to the runtime diagnostics
 * directory. Only the Developer Tools card calls this, after the user agreed;
 * it reads the Goal tables read-only and uploads nothing.
 */
async function exportGoalDiagnostics() {
    const dataDir = resolveLocalRuntimeDataDir();
    const goal = await importEsm('@mavis/local-runtime-v2');
    const nowMs = Date.now();
    const source = new goal.ThreadGoalDecisionDiagnosticSource((query) => goal.readGoalDiagnosticRows(dataDir, query));
    const [artifact] = await source.collect({
        sinceMs: nowMs - GOAL_DIAGNOSTICS_WINDOW_MS,
        nowMs,
        limits: { maxFiles: 1, maxBytes: GOAL_DIAGNOSTICS_MAX_BYTES },
    });
    if (!artifact?.content)
        return { status: 'empty' };
    const directory = path.join(resolveLocalRuntimeV2DirectoryContract(dataDir).diagnostics, 'goal');
    await mkdir(directory, { recursive: true });
    const filePath = path.join(directory, `goal-decision-evidence-${nowMs}.json`);
    await writeFile(filePath, artifact.content);
    lastGoalDiagnosticsPath = filePath;
    return { status: 'generated', path: filePath, bytes: artifact.bytes };
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
        assertDeveloperToolsAvailable();
        return getUtilityRuntimeMemoryMonitorState();
    });
    ipcMain.handle(IPC_CHANNELS.RUNTIME_MEMORY_MONITOR_SET_RECORDING, (_event, enabled, intervalMs) => {
        assertDeveloperToolsAvailable();
        return setUtilityRuntimeMemoryRecording(enabled, intervalMs);
    });
    ipcMain.handle(IPC_CHANNELS.RUNTIME_MEMORY_MONITOR_CLEAR, () => {
        assertDeveloperToolsAvailable();
        return clearUtilityRuntimeMemorySamples();
    });
    ipcMain.handle(IPC_CHANNELS.RUNTIME_MEMORY_MONITOR_START_HEAP_SAMPLING, () => {
        assertDeveloperToolsAvailable();
        return startUtilityRuntimeHeapSampling();
    });
    ipcMain.handle(IPC_CHANNELS.RUNTIME_MEMORY_MONITOR_STOP_HEAP_SAMPLING, () => {
        assertDeveloperToolsAvailable();
        return stopUtilityRuntimeHeapSampling();
    });
    ipcMain.handle(IPC_CHANNELS.GOAL_DIAGNOSTICS_EXPORT, async () => {
        assertDeveloperToolsAvailable();
        return exportGoalDiagnostics();
    });
    ipcMain.handle(IPC_CHANNELS.GOAL_DIAGNOSTICS_REVEAL, () => {
        assertDeveloperToolsAvailable();
        if (!lastGoalDiagnosticsPath)
            return { success: false, error: 'export_unavailable' };
        shell.showItemInFolder(lastGoalDiagnosticsPath);
        return { success: true };
    });
    ipcMain.handle(IPC_CHANNELS.RUNTIME_MEMORY_MONITOR_REVEAL_PROFILE, () => {
        assertDeveloperToolsAvailable();
        const profilePath = getUtilityRuntimeMemoryMonitorState().lastProfile?.profilePath;
        if (!profilePath || !isOwnedRuntimeHeapProfile(profilePath)) {
            return { success: false, error: 'profile_unavailable' };
        }
        shell.showItemInFolder(profilePath);
        return { success: true };
    });
}
