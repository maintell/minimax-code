/** Metrics are diagnostic only and must never change the application result. */
export function countApplicationMetric(metrics, name, tags) {
    try {
        metrics?.counter(name, 1, tags);
    }
    catch {
        // A telemetry outage must not turn a successful Desktop operation into a failure.
    }
}
//# sourceMappingURL=metrics.js.map