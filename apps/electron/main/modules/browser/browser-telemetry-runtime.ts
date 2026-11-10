import { app } from "electron";
import { getCategoryLogger } from "../../utils/logger";
import { enqueueElectronObservabilityEvent } from "../observability/outbox";
import { browserBackendPolicy } from "./browser-backend-policy.js";
import { browserGuestRegistry } from "./browser-guest-registry.js";
import { BrowserTelemetry } from "./browser-telemetry.js";
const logger = getCategoryLogger('archon', 'browser-input');
/** OS process ids that currently host a Browser/Mini App page. */
let browserProcessIds = () => new Set();
export function setBrowserTelemetryProcessSource(source) {
    browserProcessIds = source;
}
function sampleBrowserResources() {
    const pids = browserProcessIds();
    let rssKb = 0;
    let cpu = 0;
    let mainKb = 0;
    for (const metric of app.getAppMetrics()) {
        if (metric.type === 'Browser')
            mainKb = metric.memory.workingSetSize;
        if (!pids.has(metric.pid))
            continue;
        rssKb += metric.memory.workingSetSize;
        cpu += metric.cpu.percentCPUUsage;
    }
    return {
        browserRssMb: Math.round(rssKb / 1024),
        browserCpuPct: Math.round(cpu * 10) / 10,
        mainRssMb: Math.round(mainKb / 1024),
    };
}
export let browserTelemetry = new BrowserTelemetry({
    enqueue: (eventName, payload, kind) => enqueueElectronObservabilityEvent(eventName, payload, kind),
    log: (record) => logger.info(record),
    now: () => Date.now(),
    launch: () => {
        const snapshot = browserBackendPolicy.diagnosticSnapshot();
        return {
            launchBackend: snapshot.launchBackend,
            launchSource: snapshot.launchSource,
            policyRevision: snapshot.revision,
            pendingRestart: snapshot.launchBackend !== null &&
                snapshot.latestBackend !== null &&
                snapshot.latestBackend !== snapshot.launchBackend,
        };
    },
    sampleResources: sampleBrowserResources,
});
browserBackendPolicy.onLaunchDecided((decision) => browserTelemetry.reportLaunch({
    backend: decision.backend,
    waitMs: decision.waitMs,
    latestBackend: decision.latestBackend,
}));
browserGuestRegistry.setObserver({
    guestFailed: (stage, hostKind) => {
        browserTelemetry.count('webview', 'attach_failed_count');
        browserTelemetry.report('browser.guest_attach_failed', { rendererBackend: 'webview' }, { stage, host_kind: hostKind }, { cooldownKey: `guest:${stage}:${hostKind}`, kind: 'error' });
    },
    hostReset: (cause, guestCount, hostKind) => browserTelemetry.report('browser.host_reset', { rendererBackend: 'webview' }, { cause, guest_count: guestCount, host_kind: hostKind }, { cooldownKey: `host:${hostKind}`, kind: cause === 'crash' ? 'error' : 'action' }),
    guestCount: (count) => browserTelemetry.guestCount('webview', count),
});
/** Called once before quit so the final summaries reach the persistent outbox. */
export function flushBrowserTelemetryOnQuit() {
    browserTelemetry.sampleResources('quit');
    browserTelemetry.flushSessions('quit');
    browserTelemetry.dispose();
}
