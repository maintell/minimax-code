import { app } from "electron";
import os from "node:os";
/**
 * Memory the OS can hand out without swapping. Plain `free` is misleading on
 * macOS, which keeps it near zero and parks reclaimable memory in the file
 * cache, so free + file-backed + purgeable is used there; Linux reports
 * MemAvailable directly and Windows `free` already counts the standby list.
 */
export function availableSystemMemoryBytes(info, platform = process.platform) {
    const kib = (value) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
    let available = kib(info.free);
    if (platform === 'darwin')
        available += kib(info.fileBacked) + kib(info.purgeable);
    else if (platform === 'linux' && typeof info.available === 'number')
        available = kib(info.available);
    return Math.min(available, kib(info.total)) * 1024;
}
function readSystemMemory() {
    try {
        // `process.getSystemMemoryInfo` is the Electron API; `app` has no such method.
        const getter = process
            .getSystemMemoryInfo;
        if (typeof getter !== 'function')
            throw new Error('system memory metrics unavailable');
        const memory = getter.call(process);
        const totalBytes = Math.max(0, memory.total) * 1024;
        if (totalBytes > 0)
            return { totalBytes, availableBytes: availableSystemMemoryBytes(memory) };
    }
    catch {
        // Fall through to Node's cross-platform memory sample.
    }
    // Outside Electron only Node's view is available; it reports free pages only.
    return { totalBytes: os.totalmem(), availableBytes: os.freemem() };
}
export function deviceHiddenTabCap(totalBytes) {
    const gib = totalBytes / 1024 ** 3;
    if (gib <= 8)
        return 1;
    if (gib <= 16)
        return 2;
    return 3;
}
export function classifyBrowserMemoryPressure(sample) {
    const ratio = sample.totalBytes > 0 ? sample.availableBytes / sample.totalBytes : 0;
    if (sample.availableBytes < 1024 ** 3 || ratio < 0.08)
        return 'critical';
    if (sample.availableBytes < 2 * 1024 ** 3 || ratio < 0.15)
        return 'moderate';
    return 'normal';
}
export class EmbeddedBrowserAdaptiveBudget {
    constructor(options = {}) {
        this.options = options;
        this.pressure = 'normal';
        this.healthySamples = 0;
    }
    sample(tabs) {
        const memory = (this.options.readMemory ?? readSystemMemory)();
        const measuredPressure = classifyBrowserMemoryPressure(memory);
        const pressureRank = { normal: 0, moderate: 1, critical: 2 };
        if (pressureRank[measuredPressure] < pressureRank[this.pressure]) {
            this.healthySamples += 1;
            if (this.healthySamples >= 2) {
                this.pressure = measuredPressure;
                this.healthySamples = 0;
            }
        }
        else {
            this.healthySamples = 0;
            this.pressure = measuredPressure;
        }
        const deviceCap = deviceHiddenTabCap(memory.totalBytes);
        const hiddenTabBudget = this.pressure === 'critical'
            ? 0
            : this.pressure === 'moderate'
                ? Math.min(1, deviceCap)
                : deviceCap;
        const estimatedWorkingSetKiBByTabId = this.estimateWorkingSet(tabs);
        return {
            hiddenTabBudget,
            deviceCap,
            pressure: this.pressure,
            availableBytes: memory.availableBytes,
            totalBytes: memory.totalBytes,
            estimatedWorkingSetKiBByTabId,
        };
    }
    estimateWorkingSet(tabs) {
        const result = new Map();
        let metrics = [];
        try {
            metrics = (this.options.getAppMetrics ?? (() => app.getAppMetrics()))();
        }
        catch {
            return result;
        }
        const workingSetByPid = new Map(metrics.map((metric) => [metric.pid, metric.memory?.workingSetSize ?? 0]));
        const tabsByPid = new Map();
        for (const tab of tabs) {
            try {
                const pid = tab.webContents?.isDestroyed() ? 0 : (tab.webContents?.getOSProcessId() ?? 0);
                if (pid <= 0)
                    continue;
                const bucket = tabsByPid.get(pid) ?? [];
                bucket.push(tab);
                tabsByPid.set(pid, bucket);
            }
            catch {
                // Ignore WebContents teardown races.
            }
        }
        for (const [pid, processTabs] of tabsByPid) {
            const perTab = (workingSetByPid.get(pid) ?? 0) / processTabs.length;
            for (const tab of processTabs)
                result.set(tab.tabId, perTab);
        }
        return result;
    }
}

export function memoryWeightedLruValue(lastUsedAt, estimatedWorkingSetKiB) {
    const memoryAgeBonusMs = Math.min(30 * 60 * 1000, Math.max(0, estimatedWorkingSetKiB) * 5);
    return lastUsedAt - memoryAgeBonusMs;
}
