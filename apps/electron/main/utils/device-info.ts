/**
 * Device info collection for telemetry / event tracking.
 *
 * Centralises the device metadata that index.ts logs at startup.
 * Main consumer: daemon startup failure event.
 */
import os from "node:os";
import { app } from "electron";
import { hotUpdateManager } from "../modules/hotUpdate";
/**
 * Collect current device info. Safe to call at any point after app ready.
 * All fields are best-effort — individual failures fall back to 'unknown'.
 */
export function getDeviceInfo() {
    let cpuModel = 'unknown';
    let cpuCores = 0;
    try {
        const cpus = os.cpus();
        cpuModel = cpus.length > 0 ? cpus[0].model.trim() : 'unknown';
        cpuCores = cpus.length;
    }
    catch {
        // best-effort
    }
    const osName = process.platform === 'darwin'
        ? 'macOS'
        : process.platform === 'win32'
            ? 'Windows'
            : process.platform;
    return {
        app_version: app.getVersion(),
        hot_update_version: hotUpdateManager?.getCurrentVersion?.() || '',
        os_name: osName,
        os_version: os.release(),
        arch: process.arch,
        cpu_model: cpuModel,
        cpu_cores: cpuCores,
        total_memory_gb: (os.totalmem() / 1024 ** 3).toFixed(1),
        electron_version: process.versions.electron || 'unknown',
        chrome_version: process.versions.chrome || 'unknown',
        node_version: process.versions.node || 'unknown',
    };
}
