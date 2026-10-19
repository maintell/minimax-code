const PHASES = { workspace: true, path: true, git: true, total: true };
const OUTCOMES = { success: true, error: true, skipped: true };
const REASONS = {
    policy: true,
    count_limit: true,
    byte_limit: true,
    directory_limit: true,
    scan_limit: true,
    unavailable: true,
};
export function recordCollectionObservation(metrics, event) {
    if (!metrics || !Object.hasOwn(PHASES, event.phase) || !Object.hasOwn(OUTCOMES, event.outcome))
        return;
    const labels = { os: process.platform, phase: event.phase, outcome: event.outcome };
    try {
        metrics.counter('meta_info_collect_total', 1, labels);
        recordFinite(metrics, 'meta_info_collect_duration_ms', event.durationMs, labels);
        recordFinite(metrics, 'meta_info_process_cpu_ms', event.cpuTimeMs, labels);
        if (event.rssDeltaBytes !== undefined && Number.isFinite(event.rssDeltaBytes)) {
            metrics.histogram('meta_info_process_rss_delta_bytes', event.rssDeltaBytes, labels);
        }
        recordFinite(metrics, 'meta_info_items', event.rawCount, {
            phase: event.phase,
            kind: 'observed',
        });
        recordFinite(metrics, 'meta_info_items', event.filteredCount, {
            phase: event.phase,
            kind: 'filtered',
        });
        recordFinite(metrics, 'meta_info_items', event.retainedCount, {
            phase: event.phase,
            kind: 'retained',
        });
        recordFinite(metrics, 'meta_info_output_bytes', event.outputBytes, { phase: event.phase });
        if (event.truncated) {
            const reason = event.reason && Object.hasOwn(REASONS, event.reason) ? event.reason : 'scan_limit';
            metrics.counter('meta_info_truncated_total', 1, {
                os: process.platform,
                stage: event.phase,
                reason,
            });
        }
        if (event.scanComplete === false && event.outcome !== 'skipped') {
            metrics.counter('meta_info_incomplete_scan_total', 1, {
                os: process.platform,
                phase: event.phase,
            });
        }
    }
    catch {
        // Metrics are observational: a broken sink must not drop a collected snapshot.
    }
}
export function recordMetaInfoPayload(metrics, sizeBytes, maxBytes) {
    if (!metrics)
        return;
    try {
        metrics.histogram('meta_info_payload_bytes', sizeBytes, { os: process.platform });
        if (sizeBytes > maxBytes) {
            metrics.counter('meta_info_truncated_total', 1, {
                os: process.platform,
                stage: 'step_field',
                reason: 'byte_limit',
            });
        }
    }
    catch {
        // Preserve the reporter's existing payload and transport semantics.
    }
}
export function recordEvalUpload(metrics, request, outcome, durationMs) {
    if (!metrics)
        return;
    try {
        const labels = { os: process.platform, kind: request.kind, outcome };
        metrics.counter('eval_upload_total', 1, labels);
        recordFinite(metrics, 'eval_upload_duration_ms', durationMs, labels);
        metrics.histogram('eval_upload_bytes', Buffer.byteLength(request.body, 'utf8'), labels);
        if (request.containsMetaInfo) {
            metrics.counter('meta_info_upload_total', 1, { os: process.platform, outcome });
            recordFinite(metrics, 'meta_info_upload_duration_ms', durationMs, { outcome });
        }
    }
    catch {
        // Do not retry or fail an eval request because telemetry failed.
    }
}
function recordFinite(metrics, name, value, labels) {
    if (value !== undefined && Number.isFinite(value) && value >= 0) {
        metrics.histogram(name, value, { os: process.platform, ...labels });
    }
}
//# sourceMappingURL=metrics.js.map