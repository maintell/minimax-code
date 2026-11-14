import { app } from "electron";
import { isManagedRuntime, getRuntimeBuildEnv, getRuntimeRegion } from "@mavis/config";
import { incrementMetric, observeMetric, createLocalRuntimeMetricsClient, registeredHistogramBucketsByName, DESKTOP_METRICS_DELIVERY, createLocalRuntimeDesktopReporter } from "@mavis/shared/local-runtime-logging/metrics";
import logger from "../../utils/logger";
import { resolveElectronNetFetch } from "../local-runtime/electron-net-fetch";
/** Lazily creates its client on the first report; after close() reports are dropped. */
export class DesktopMainMetrics {
    constructor(createClient) {
        this.createClient = createClient;
        this.closed = false;
    }
    increment(name, delta, labels) {
        incrementMetric(this.sink(), name, delta, labels);
    }
    observe(name, value, labels) {
        observeMetric(this.sink(), name, value, labels);
    }
    /** Send what is left. Later reports are dropped. */
    async close() {
        this.closed = true;
        const client = this.client;
        this.client = undefined;
        try {
            await client?.close();
        }
        catch {
            // Metrics never fail the quit sequence.
        }
    }
    sink() {
        if (this.closed)
            return undefined;
        try {
            this.client ?? (this.client = this.createClient());
        }
        catch {
            return undefined;
        }
        return this.client;
    }
}

const desktopMetrics = new DesktopMainMetrics(createMainProcessMetricsClient);
export function incrementDesktopMetric(name, delta, labels) {
    desktopMetrics.increment(name, delta, labels);
}
export function observeDesktopMetric(name, value, labels) {
    desktopMetrics.observe(name, value, labels);
}
/** Flush and stop the main-process client; the quit sequence calls it after the runtime stops. */
export function closeDesktopMetrics() {
    return desktopMetrics.close();
}
function createMainProcessMetricsClient() {
    return createLocalRuntimeMetricsClient({
        runtimeOwnerKind: 'electron',
        appVersion: app.getVersion(),
        histogramBucketsByName: registeredHistogramBucketsByName(),
        ...(isManagedRuntime() ? { reporter: managedReporter() } : {}),
        delivery: DESKTOP_METRICS_DELIVERY,
        onError: (error) => {
            logger.warn(`[DesktopMetrics] report failed: ${error instanceof Error ? error.message : String(error)}`);
        },
    });
}
function managedReporter() {
    const buildEnv = getRuntimeBuildEnv();
    const netFetch = resolveElectronNetFetch();
    return createLocalRuntimeDesktopReporter({
        ...(netFetch ? { fetch: netFetch } : {}),
        isEn: getRuntimeRegion() === 'en',
        isProd: buildEnv === 'prod',
        isStaging: buildEnv === 'staging',
        isDev: buildEnv === 'dev',
    });
}
