import { incrementMetric, } from '@mavis/shared/local-runtime-logging/metric-registry';
export function reportPtcStoreMetrics(metrics, counts, surface) {
    if (counts.writes)
        incrementMetric(metrics, 'ptc_store_write_total', counts.writes, { surface });
    if (counts.loads)
        incrementMetric(metrics, 'ptc_store_load_total', counts.loads, { surface });
}
//# sourceMappingURL=ptc-store-metrics.js.map