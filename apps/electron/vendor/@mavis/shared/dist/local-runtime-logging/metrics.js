import { MetricsClient, createDesktopReporter, } from '../metrics-proxy.js';
const SERVICE_NAME = 'local_runtime';
const SERVER_APPLIED_PREFIX = 'local_runtime_';
/**
 * Delivery of the Desktop clients (the local runtime and the Electron main
 * process): failed sends back off and carry their counts over, and drops are
 * counted in metrics_client_dropped_points_total. See MetricsDelivery.
 */
export const DESKTOP_METRICS_DELIVERY = Object.freeze({
    mode: 'carry_over',
});
class NoopMetricsReporter {
    async reportBatch() {
        return { accepted: 0 };
    }
}
/**
 * Build a `MetricsClient` for the `local_runtime` service with the
 * conventional default labels. Host code wires the resulting client into
 * modules that need to emit counters / histograms; business code never
 * instantiates one.
 */
export function createLocalRuntimeMetricsClient(options) {
    const appVersion = options.appVersion ?? 'unknown';
    const metricAppVersion = /^\d+\.\d+\.\d+$/u.test(appVersion)
        ? appVersion
        : (appVersion.match(/^(\d+\.\d+\.\d+-(?:preview|inside|test|staging))(?:[.+-].*)?$/u)?.[1] ??
            'unknown');
    const defaultLabels = {
        runtimeOwnerKind: options.runtimeOwnerKind,
        appVersion: metricAppVersion,
        ...(options.runtimeMode ? { runtimeMode: options.runtimeMode } : {}),
    };
    return new MetricsClient({
        serviceName: SERVICE_NAME,
        reporter: options.reporter ?? new NoopMetricsReporter(),
        defaultLabels,
        ...(options.histogramBucketsByName
            ? { histogramBucketsByName: options.histogramBucketsByName }
            : {}),
        ...(options.delivery ? { delivery: options.delivery } : {}),
        ...(options.onError ? { onError: options.onError } : {}),
        ...(options.now ? { now: options.now } : {}),
    });
}
/**
 * Thin wrapper around `createDesktopReporter` so callers do not need to
 * remember the upstream import path — the facade is the only allowed entry.
 */
export function createLocalRuntimeDesktopReporter(options) {
    return createDesktopReporter(options);
}
/**
 * Runtime-time guard so accidental `metrics.counter('local_runtime_x', …)`
 * misuse fails fast in tests instead of storing double-prefixed prod
 * time-series: the metrics server already prepends the service name
 * (`local_runtime_`), so client-side names must be BARE. Production code
 * paths can call `assertLocalMetricName` inside their own helpers when they
 * want belt-and-suspenders coverage.
 */
export function assertLocalMetricName(name) {
    if (name.startsWith(SERVER_APPLIED_PREFIX)) {
        throw new Error(`local-runtime metric '${name}' must NOT start with '${SERVER_APPLIED_PREFIX}' — ` +
            `the metrics server prepends the service name ('${SERVICE_NAME}') to every metric.`);
    }
}
/**
 * Time an async block and emit `<name>{status=ok|error}` latency through the
 * optional reporter. Errors are rethrown untouched; without a reporter the
 * wrapper is behaviorally a plain passthrough.
 */
export async function timeRouteDuration(metrics, name, run) {
    const startMs = Date.now();
    try {
        const result = await run();
        metrics?.latency(name, Date.now() - startMs, { status: 'ok' });
        return result;
    }
    catch (err) {
        metrics?.latency(name, Date.now() - startMs, { status: 'error' });
        throw err;
    }
}
export { LONG_TAIL_HISTOGRAM_BOUNDS, createBusyTimeAccumulator, incrementMetric, observeMetric, registeredHistogramBucketsByName, } from './metric-registry.js';
//# sourceMappingURL=metrics.js.map