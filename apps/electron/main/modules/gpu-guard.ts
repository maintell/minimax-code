/**
 * Windows GPU crash guard.
 *
 * Some Windows GPU drivers can crash Chromium during startup with
 * STATUS_BREAKPOINT (0x80000003). The guard writes a startup sentinel before
 * the GPU process is likely to initialize; if the previous launch did not clear
 * it, the next launch falls back to software rendering for the same Electron
 * version.
 */

import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
const SENTINEL_FILENAME = '.gpu-crash-sentinel';
const GPU_DISABLE_FEATURES = ['UseSkiaRenderer', 'VizDisplayCompositor', 'CanvasOopRasterization'];
let gpuDisabledByGuard = false;
function getSentinelPath() {
    return path.join(app.getPath('userData'), SENTINEL_FILENAME);
}
function isWindows() {
    return process.platform === 'win32';
}
export function applyGpuGuard() {
    const electronVersion = process.versions.electron;
    if (process.argv.includes('--disable-gpu')) {
        disableGpuForStartup();
        return 'CLI flag --disable-gpu';
    }
    if (!isWindows()) {
        removeSentinel();
        return null;
    }
    const sentinel = readSentinel();
    if (sentinel) {
        if (sentinel.electronVersion === electronVersion) {
            disableGpuForStartup();
            return `GPU crash detected on previous launch (Electron ${electronVersion})`;
        }
        removeSentinel();
    }
    writeSentinel(electronVersion);
    return null;
}
export function clearGpuSentinel() {
    if (!gpuDisabledByGuard) {
        removeSentinel();
    }
}
export function isGpuDisabledByGuard() {
    return gpuDisabledByGuard;
}
function readSentinel() {
    try {
        return JSON.parse(fs.readFileSync(getSentinelPath(), 'utf-8'));
    }
    catch {
        return null;
    }
}
function writeSentinel(electronVersion) {
    try {
        const sentinelPath = getSentinelPath();
        fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
        const data = { electronVersion, timestamp: Date.now() };
        fs.writeFileSync(sentinelPath, JSON.stringify(data));
    }
    catch {
        // Best-effort only. Startup should not fail if the sentinel cannot be written.
    }
}
function disableGpuForStartup() {
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('disable-gpu-compositing');
    app.commandLine.appendSwitch('disable-features', GPU_DISABLE_FEATURES.join(','));
    gpuDisabledByGuard = true;
}
function removeSentinel() {
    try {
        fs.unlinkSync(getSentinelPath());
    }
    catch {
        // Missing or inaccessible sentinel is non-fatal.
    }
}
