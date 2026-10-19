/**
 * Starts a process-wide CPU/RSS sample and returns its reader.
 *
 * Both figures are approximations of a stage's cost, not an exclusive
 * attribution: anything else the runtime does concurrently lands in the same
 * window. Sampled once per stage — never per file — and only around stages
 * that genuinely burn local CPU, so network waiting is never charged as
 * compute. The RSS delta is signed: clamping a net release to zero would bias
 * the distribution upward and hide collection that the stage triggered.
 */
export function beginWorkspaceIndexingLocalCost() {
    const cpuStart = process.cpuUsage();
    const rssStart = process.memoryUsage.rss();
    return () => {
        const cpu = process.cpuUsage(cpuStart);
        return {
            cpuTimeMs: (cpu.user + cpu.system) / 1000,
            rssDeltaBytes: process.memoryUsage.rss() - rssStart,
        };
    };
}
/**
 * Windows and macOS differ enough in filesystem walk cost and noise volume
 * that a shared series hides both. `local_runtime` default labels carry no
 * platform, so this domain adds its own bounded `os` dimension rather than
 * changing the shared reporter for every other metric.
 */
const KNOWN_METRIC_PLATFORMS = { darwin: true, linux: true, win32: true };
export class WorkspaceIndexingMetrics {
    sink;
    os;
    constructor(sink, platform = process.platform) {
        this.sink = sink;
        this.os = Object.hasOwn(KNOWN_METRIC_PLATFORMS, platform) ? platform : 'other';
    }
    /**
     * One physical attempt: every retry, cancellation, and poll counts once.
     * Divide by {@link result} to read the retry amplification of a stage.
     */
    attempt(input) {
        const sink = this.sink;
        if (!sink)
            return;
        try {
            sink.counter('workspace_indexing_stage_attempt_total', 1, {
                stage: input.stage,
                outcome: input.outcome,
                kind: input.kind ?? 'none',
                os: this.os,
            });
            if (input.durationMs !== undefined) {
                sink.histogram('workspace_indexing_stage_duration_ms', input.durationMs, {
                    stage: input.stage,
                    outcome: input.outcome,
                    os: this.os,
                });
            }
        }
        catch {
            // Observability is a weak dependency: never fail a capture over it.
        }
    }
    /**
     * One logical completion per Revision or per user-visible operation, so a
     * revision that succeeded after five retries reports a single success here.
     */
    result(input) {
        const sink = this.sink;
        if (!sink)
            return;
        try {
            sink.counter('workspace_indexing_stage_result_total', 1, {
                stage: input.stage,
                outcome: input.outcome,
                reason: input.reason ?? 'none',
                kind: input.kind ?? 'none',
                os: this.os,
            });
        }
        catch {
            // Weak dependency.
        }
    }
    retry(stage, reason) {
        const sink = this.sink;
        if (!sink)
            return;
        try {
            sink.counter('workspace_indexing_retry_total', 1, { stage, reason, os: this.os });
        }
        catch {
            // Weak dependency.
        }
    }
    payloadBytes(payload, bytes, kind = 'none') {
        const sink = this.sink;
        if (!sink)
            return;
        try {
            sink.histogram('workspace_indexing_payload_bytes', bytes, {
                payload,
                kind,
                os: this.os,
            });
        }
        catch {
            // Weak dependency.
        }
    }
    fileCount(stage, count) {
        const sink = this.sink;
        if (!sink)
            return;
        try {
            sink.histogram('workspace_indexing_file_count', count, { stage, os: this.os });
        }
        catch {
            // Weak dependency.
        }
    }
    /**
     * Local compute cost of one stage. Emitted only for `scan` and `archive`,
     * the two stages that actually run work on the user's machine; network
     * waits are never charged as CPU. Both figures are process-wide
     * approximations, so concurrent runtime work inflates them.
     */
    localCost(stage, cost) {
        const sink = this.sink;
        if (!sink)
            return;
        try {
            sink.histogram('workspace_indexing_stage_cpu_ms', cost.cpuTimeMs, { stage, os: this.os });
            sink.histogram('workspace_indexing_stage_rss_delta_bytes', cost.rssDeltaBytes, {
                stage,
                os: this.os,
            });
        }
        catch {
            // Weak dependency.
        }
    }
    inflight(stage, value) {
        const sink = this.sink;
        if (!sink)
            return;
        try {
            sink.gauge('workspace_indexing_inflight', value, { stage, os: this.os });
        }
        catch {
            // Weak dependency.
        }
    }
    /**
     * Depth and head-of-line age of the durable remote queue. `oldestAgeMs` is
     * the age of the oldest due Revision, which is what turns a silent backlog
     * into an alertable signal.
     */
    backlog(pending, oldestAgeMs) {
        const sink = this.sink;
        if (!sink)
            return;
        try {
            sink.gauge('workspace_indexing_backlog', pending, { os: this.os });
            sink.gauge('workspace_indexing_backlog_oldest_age_ms', oldestAgeMs, { os: this.os });
        }
        catch {
            // Weak dependency.
        }
    }
}
/**
 * Delivers a low-frequency lifecycle observation to the business layer. A
 * throwing observer must not change what the runtime captured, so failures are
 * contained here rather than at every call site.
 */
export function emitWorkspaceIndexingObservation(sink, event) {
    if (!sink)
        return;
    try {
        sink(event);
    }
    catch {
        // Weak dependency.
    }
}
/**
 * Fixes the observation sink one operation will report to, before that
 * operation performs any work. Every later completion or failure event of the
 * operation goes to this sink even if the owner changed meanwhile, so a
 * finished capture is never attributed to whoever happens to be signed in when
 * it lands. A throwing factory simply leaves the operation unobserved.
 */
export function resolveWorkspaceIndexingObservationSink(createSink) {
    if (!createSink)
        return undefined;
    try {
        return createSink();
    }
    catch {
        // Weak dependency.
        return undefined;
    }
}
//# sourceMappingURL=metrics.js.map