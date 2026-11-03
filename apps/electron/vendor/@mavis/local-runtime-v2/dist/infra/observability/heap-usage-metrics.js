import { constants, PerformanceObserver } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
const HEAP_USAGE_SAMPLE_INTERVAL_MS = 60_000;
export function currentHeapUsageBucket() {
    return heapUsageBucket(currentHeapRatio());
}
function currentHeapRatio() {
    const { used_heap_size: used, heap_size_limit: limit } = getHeapStatistics();
    return limit > 0 ? used / limit : 0;
}
function heapUsageBucket(ratio) {
    if (ratio >= 0.8)
        return '>=80';
    if (ratio >= 0.6)
        return '60-80';
    if (ratio >= 0.4)
        return '40-60';
    return '<40';
}
/**
 * Adds one count per minute to the bucket of the live heap reading, and one to the bucket read
 * right after the latest major GC. Live readings include garbage that is not collected yet, so
 * the two series together show which reading suits a memory pressure threshold.
 */
export function startHeapUsageMetrics(options) {
    const readRatio = options.readHeapRatio ?? currentHeapRatio;
    const readBucket = () => heapUsageBucket(readRatio());
    let postGcBucket;
    const observer = new PerformanceObserver((list) => {
        if (list.getEntries().some(isMajorGc))
            postGcBucket = readBucket();
    });
    try {
        observer.observe({ entryTypes: ['gc'] });
    }
    catch {
        // Without GC entries only the live reading is counted; startup must never fail here.
    }
    const timer = setInterval(() => {
        recordHeapUsage(options.metrics, 'sample', readBucket());
        if (postGcBucket)
            recordHeapUsage(options.metrics, 'post_gc', postGcBucket);
    }, options.intervalMs ?? HEAP_USAGE_SAMPLE_INTERVAL_MS);
    timer.unref();
    return {
        stop() {
            clearInterval(timer);
            observer.disconnect();
        },
    };
}
function isMajorGc(entry) {
    const detail = Reflect.get(entry, 'detail');
    return (typeof detail === 'object' &&
        detail !== null &&
        Reflect.get(detail, 'kind') === constants.NODE_PERFORMANCE_GC_MAJOR);
}
function recordHeapUsage(metrics, reading, bucket) {
    try {
        metrics.counter('heap_usage_minutes_total', 1, {
            usage_bucket: bucket,
            reading,
            mode: 'off',
            platform: process.platform,
        });
    }
    catch {
        // Observation only; a failing metrics sink never affects the runtime.
    }
}
//# sourceMappingURL=heap-usage-metrics.js.map