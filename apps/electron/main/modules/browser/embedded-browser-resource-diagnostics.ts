import { app, webContents } from "electron";
export let EMBEDDED_BROWSER_RESOURCE_SAMPLE_INTERVAL_MS = 60000;
const MAX_LOGGED_WEB_CONTENTS = 100;
function safeIsDestroyed(contents) {
    try {
        return contents.isDestroyed();
    }
    catch {
        return true;
    }
}
function safeRendererPid(contents) {
    if (safeIsDestroyed(contents))
        return null;
    try {
        const pid = contents.getOSProcessId();
        return Number.isFinite(pid) && pid > 0 ? pid : null;
    }
    catch {
        return null;
    }
}
function safeGetAppMetrics() {
    try {
        const getter = app
            ?.getAppMetrics;
        return typeof getter === 'function' ? getter.call(app) : null;
    }
    catch {
        return null;
    }
}
function safeWebContentsType(contents) {
    try {
        return contents.getType();
    }
    catch {
        return null;
    }
}
function safeGetAllWebContentsSnapshot() {
    try {
        const getter = webContents?.getAllWebContents;
        if (typeof getter !== 'function')
            return null;
        const alive = getter
            .call(webContents)
            .filter((contents) => !safeIsDestroyed(contents))
            .sort((a, b) => a.id - b.id);
        return {
            total: alive.length,
            truncated: alive.length > MAX_LOGGED_WEB_CONTENTS,
            items: alive.slice(0, MAX_LOGGED_WEB_CONTENTS).map((contents) => ({
                webContentsId: contents.id,
                rendererPid: safeRendererPid(contents),
                type: safeWebContentsType(contents),
            })),
        };
    }
    catch {
        return null;
    }
}
function mainProcessMemory() {
    try {
        const memory = process.memoryUsage();
        return {
            pid: process.pid,
            rssBytes: memory.rss,
            heapTotalBytes: memory.heapTotal,
            heapUsedBytes: memory.heapUsed,
            externalBytes: memory.external,
            arrayBuffersBytes: memory.arrayBuffers,
        };
    }
    catch {
        return null;
    }
}
export function collectEmbeddedBrowserResourceSnapshot(args) {
    const metrics = safeGetAppMetrics();
    const allWebContentsSnapshot = safeGetAllWebContentsSnapshot();
    const metricByPid = new Map();
    for (const metric of metrics ?? []) {
        if (typeof metric.pid === 'number')
            metricByPid.set(metric.pid, metric);
    }
    const trackedWebContents = args.tabs
        .map((tab) => {
        const contents = tab.webContents;
        const destroyed = contents === null || safeIsDestroyed(contents);
        return {
            tabId: tab.tabId,
            sessionId: tab.sessionId,
            hidden: tab.hidden,
            operationCount: tab.operationCount,
            webContentsId: contents?.id ?? null,
            rendererPid: contents && !destroyed ? safeRendererPid(contents) : null,
            destroyed,
        };
    })
        .sort((a, b) => a.tabId - b.tabId);
    const resourcesByPid = new Map();
    for (const resource of trackedWebContents) {
        if (resource.rendererPid === null)
            continue;
        const resources = resourcesByPid.get(resource.rendererPid) ?? [];
        resources.push(resource);
        resourcesByPid.set(resource.rendererPid, resources);
    }
    const rendererProcesses = Array.from(resourcesByPid.entries())
        .map(([rendererPid, resources]) => {
        const metric = metricByPid.get(rendererPid);
        return {
            rendererPid,
            processType: metric?.type ?? null,
            trackedWebContentsCount: resources.length,
            visibleWebContentsCount: resources.filter((resource) => !resource.hidden).length,
            hiddenWebContentsCount: resources.filter((resource) => resource.hidden).length,
            workingSetSizeKiB: metric?.memory?.workingSetSize ?? null,
            peakWorkingSetSizeKiB: metric?.memory?.peakWorkingSetSize ?? null,
            privateBytesKiB: metric?.memory?.privateBytes ?? null,
            cpuPercent: metric?.cpu?.percentCPUUsage ?? null,
        };
    })
        .sort((a, b) => a.rendererPid - b.rendererPid);
    const electronProcesses = metrics
        ?.map((metric) => ({
        pid: metric.pid ?? null,
        type: metric.type ?? null,
        workingSetSizeKiB: metric.memory?.workingSetSize ?? null,
        peakWorkingSetSizeKiB: metric.memory?.peakWorkingSetSize ?? null,
        privateBytesKiB: metric.memory?.privateBytes ?? null,
        cpuPercent: metric.cpu?.percentCPUUsage ?? null,
    }))
        .sort((a, b) => (a.pid ?? 0) - (b.pid ?? 0));
    const visibleTabCount = args.tabs.filter((tab) => !tab.hidden).length;
    const hiddenTabCount = args.tabs.length - visibleTabCount;
    const activeOperationCount = args.tabs.reduce((total, tab) => total + Math.max(0, tab.operationCount), 0);
    return {
        reason: args.reason,
        ts: Date.now(),
        lifecycle: {
            ...args.counters,
            balance: args.counters.created - args.counters.destroyed,
            logicalTabBalance: args.counters.created - args.counters.destroyed,
            webContentsBalance: args.counters.created - args.counters.webContentsDestroyed,
        },
        manager: {
            trackedTabCount: args.tabs.length,
            visibleTabCount,
            hiddenTabCount,
            activeOperationCount,
            trackedWebContentsCount: trackedWebContents.filter((resource) => resource.webContentsId !== null).length,
            aliveTrackedWebContentsCount: trackedWebContents.filter((resource) => !resource.destroyed)
                .length,
            destroyedTrackedWebContentsCount: trackedWebContents.filter((resource) => resource.destroyed)
                .length,
        },
        electron: {
            allWebContentsCount: allWebContentsSnapshot?.total ?? null,
            allWebContentsTruncated: allWebContentsSnapshot?.truncated ?? null,
            appMetricsAvailable: metrics !== null,
            appMetricProcessCount: metrics?.length ?? null,
        },
        mainProcess: mainProcessMemory(),
        electronProcesses: electronProcesses ?? null,
        rendererProcesses,
        allWebContents: allWebContentsSnapshot?.items ?? null,
        trackedWebContents,
    };
}
export class EmbeddedBrowserResourceDiagnostics {
    constructor(options) {
        this.options = options;
        this.sampleTimer = null;
        this.counters = {
            created: 0,
            destroyed: 0,
            webContentsDestroyed: 0,
            renderProcessGone: 0,
        };
    }
    onTabCreated() {
        this.counters.created += 1;
        this.ensureSampleTimer();
        this.sample('tab-created');
    }
    onTabDestroying() {
        this.counters.destroyed += 1;
    }
    onTabDestroyed() {
        this.stopSampleTimerIfIdle();
        this.sample('tab-destroyed');
    }
    onWebContentsDestroyed() {
        this.counters.webContentsDestroyed += 1;
    }
    onRenderProcessGone() {
        this.counters.renderProcessGone += 1;
    }
    sample(reason) {
        this.options.log(collectEmbeddedBrowserResourceSnapshot({
            reason,
            counters: { ...this.counters },
            tabs: this.options.getTabs(),
        }));
    }
    ensureSampleTimer() {
        if (this.options.periodicSamplingEnabled !== true ||
            this.sampleTimer ||
            this.options.getTabs().length === 0) {
            return;
        }
        const timer = setInterval(() => this.sample('interval'), EMBEDDED_BROWSER_RESOURCE_SAMPLE_INTERVAL_MS);
        timer.unref?.();
        this.sampleTimer = timer;
    }
    stopSampleTimerIfIdle() {
        if (!this.sampleTimer || this.options.getTabs().length > 0)
            return;
        clearInterval(this.sampleTimer);
        this.sampleTimer = null;
    }
}

