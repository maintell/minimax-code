const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_MAX_BATCH_SIZE = 1_000;
const DEFAULT_MAX_SERIES = 50_000;
const DEFAULT_MAX_LABEL_KEYS = 20;
const DEFAULT_MAX_LABEL_VALUE_LENGTH = 512;
const DEFAULT_HISTOGRAM_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000];
const DEFAULT_RETRY = {
    maxAttempts: 3,
    baseDelayMs: 250,
    maxDelayMs: 5_000,
    maxRetryBatches: 100,
    maxRetryMetrics: 100_000,
};
const METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const DEFAULT_METRICS_BATCH_PATH = '/archon/internal/api/v1/metrics/batch';
export const DESKTOP_METRICS_BATCH_PATH = '/matrix/api/v1/metrics/batch';
export class MetricsReportError extends Error {
    status;
    retryable;
    constructor(message, options) {
        super(message);
        this.name = 'MetricsReportError';
        this.status = options.status;
        this.retryable = options.retryable;
    }
}
export class MetricsReporter {
    options;
    constructor(options) {
        this.options = {
            ...options,
            ...(options.endpoint
                ? {
                    endpoint: options.endpoint.replace(/\/+$/, ''),
                    batchPath: normalizeBatchPath(options.batchPath ?? DEFAULT_METRICS_BATCH_PATH),
                }
                : {}),
        };
    }
    async reportBatch(req) {
        if (!this.options.endpoint) {
            if (!this.options.reportMetric) {
                throw new MetricsReportError('Metrics reporter requires either endpoint or reportMetric', {
                    retryable: false,
                });
            }
            for (const metric of req.metrics) {
                await this.options.reportMetric(metric, {
                    service: req.service,
                    timestamp: req.timestamp,
                });
            }
            return { accepted: req.metrics.length };
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? 3_000);
        try {
            const response = await (this.options.fetch ?? fetch)(`${this.options.endpoint}${this.options.batchPath}`, {
                method: 'POST',
                headers: {
                    ...(this.options.headers ?? {}),
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(toReportBody(req)),
                signal: controller.signal,
            });
            if (!response.ok) {
                throw new MetricsReportError(`Metrics report failed with HTTP ${response.status}`, {
                    status: response.status,
                    retryable: response.status === 429 || response.status >= 500,
                });
            }
            return (await response.json().catch(() => ({})));
        }
        catch (error) {
            if (error instanceof MetricsReportError) {
                throw error;
            }
            throw new MetricsReportError('Metrics report failed before a response was received', {
                retryable: true,
            });
        }
        finally {
            clearTimeout(timeout);
        }
    }
}
export class MetricsClient {
    reporter;
    serviceName;
    flushIntervalMs;
    maxBatchSize;
    maxSeries;
    maxLabelKeys;
    maxLabelValueLength;
    defaultLabels;
    histogramBuckets;
    histogramBucketsByName;
    stickyGauge;
    retry;
    onError;
    now;
    setTimer;
    clearTimer;
    counters = new Map();
    gauges = new Map();
    histograms = new Map();
    metricNameSeriesCounts = new Map();
    retryBuffer = [];
    flushTimer;
    flushInFlight;
    closed = false;
    constructor(options) {
        this.reporter = options.reporter;
        this.serviceName = options.serviceName;
        this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
        this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
        this.maxSeries = options.maxSeries ?? DEFAULT_MAX_SERIES;
        this.maxLabelKeys = options.maxLabelKeys ?? DEFAULT_MAX_LABEL_KEYS;
        this.maxLabelValueLength = options.maxLabelValueLength ?? DEFAULT_MAX_LABEL_VALUE_LENGTH;
        this.defaultLabels = normalizeLabels(options.defaultLabels ?? {});
        this.histogramBuckets = normalizeBuckets(options.histogramBuckets ?? DEFAULT_HISTOGRAM_BUCKETS);
        this.histogramBucketsByName = Object.fromEntries(Object.entries(options.histogramBucketsByName ?? {}).map(([name, buckets]) => [
            name,
            normalizeBuckets(buckets),
        ]));
        this.stickyGauge = options.stickyGauge ?? false;
        this.retry = { ...DEFAULT_RETRY, ...(options.retry ?? {}) };
        this.onError = options.onError;
        this.now = options.now ?? Date.now;
        this.setTimer = options.setTimer ?? setTimeout;
        this.clearTimer = options.clearTimer ?? clearTimeout;
        if (this.flushIntervalMs > 0) {
            this.scheduleFlush();
        }
    }
    counter(name, delta = 1, labels = {}) {
        if (this.closed || !Number.isFinite(delta) || delta <= 0)
            return;
        const mergedLabels = this.validateAndMergeLabels('counter', name, labels);
        if (!mergedLabels)
            return;
        const key = buildMetricKey('counter', name, mergedLabels);
        const existing = this.counters.get(key);
        const updatedAt = this.now();
        if (existing) {
            existing.value += delta;
            existing.updatedAt = updatedAt;
        }
        else {
            this.counters.set(key, { name, labels: mergedLabels, value: delta, updatedAt });
        }
        this.flushWhenFull();
    }
    gauge(name, value, labels = {}) {
        if (this.closed || !Number.isFinite(value))
            return;
        const mergedLabels = this.validateAndMergeLabels('gauge', name, labels);
        if (!mergedLabels)
            return;
        this.gauges.set(buildMetricKey('gauge', name, mergedLabels), {
            name,
            labels: mergedLabels,
            value,
            updatedAt: this.now(),
        });
        this.flushWhenFull();
    }
    histogram(name, value, labels = {}) {
        if (this.closed || !Number.isFinite(value))
            return;
        const mergedLabels = this.validateAndMergeLabels('histogram', name, labels);
        if (!mergedLabels)
            return;
        const key = buildMetricKey('histogram', name, mergedLabels);
        const buckets = this.histogramBucketsByName[name] ?? this.histogramBuckets;
        let point = this.histograms.get(key);
        if (!point) {
            point = {
                name,
                labels: mergedLabels,
                buckets,
                bucketCounts: buckets.map(() => 0),
                count: 0,
                sum: 0,
                updatedAt: this.now(),
            };
            this.histograms.set(key, point);
        }
        point.count += 1;
        point.sum += value;
        point.updatedAt = this.now();
        for (let index = 0; index < point.buckets.length; index += 1) {
            const bucket = point.buckets[index];
            if (bucket !== undefined && value <= bucket) {
                point.bucketCounts[index] = (point.bucketCounts[index] ?? 0) + 1;
            }
        }
        this.flushWhenFull();
    }
    async flush() {
        if (this.flushInFlight) {
            await this.flushInFlight;
        }
        this.flushInFlight = this.flushOnce().finally(() => {
            this.flushInFlight = undefined;
        });
        await this.flushInFlight;
    }
    async close() {
        this.closed = true;
        if (this.flushTimer) {
            this.clearTimer(this.flushTimer);
            this.flushTimer = undefined;
        }
        await this.flush();
    }
    async flushOnce() {
        const snapshot = this.takeSnapshot();
        if (snapshot.length === 0 && this.retryBuffer.length === 0)
            return;
        await this.drainRetryBuffer();
        for (const metrics of chunk(snapshot, this.maxBatchSize)) {
            await this.sendOrBuffer({
                service: this.serviceName,
                timestamp: this.now(),
                metrics,
            });
        }
    }
    async drainRetryBuffer() {
        const pending = this.retryBuffer.splice(0, this.retryBuffer.length);
        for (const batch of pending) {
            await this.sendOrBuffer(batch.request, batch.attempts);
        }
    }
    async sendOrBuffer(request, attempts = 0) {
        if (request.metrics.length === 0)
            return;
        try {
            await this.reporter.reportBatch(request);
        }
        catch (error) {
            if (isRetryableError(error) && attempts + 1 < this.retry.maxAttempts) {
                this.pushRetryBatch({ request, attempts: attempts + 1 });
            }
            else {
                this.onError?.(error);
            }
        }
    }
    pushRetryBatch(batch) {
        this.retryBuffer.push(batch);
        while (this.retryBuffer.length > this.retry.maxRetryBatches ||
            this.retryBuffer.reduce((total, item) => total + item.request.metrics.length, 0) >
                this.retry.maxRetryMetrics) {
            const dropped = this.retryBuffer.shift();
            if (!dropped)
                break;
            this.onError?.(new MetricsReportError('Metrics retry buffer exceeded its limit; dropped oldest batch', {
                retryable: false,
            }));
        }
    }
    takeSnapshot() {
        const points = [];
        for (const point of this.counters.values()) {
            points.push({
                type: 'counter',
                name: point.name,
                labels: point.labels,
                value: point.value,
                updatedAt: point.updatedAt,
            });
        }
        this.counters.clear();
        for (const point of this.gauges.values()) {
            points.push({
                type: 'gauge',
                name: point.name,
                labels: point.labels,
                value: point.value,
                updatedAt: point.updatedAt,
            });
        }
        if (!this.stickyGauge) {
            this.gauges.clear();
        }
        for (const point of this.histograms.values()) {
            points.push({
                type: 'histogram',
                name: point.name,
                labels: point.labels,
                count: point.count,
                sum: point.sum,
                buckets: Object.fromEntries(point.buckets.map((bucket, index) => [String(bucket), point.bucketCounts[index] ?? 0])),
                updatedAt: point.updatedAt,
            });
        }
        this.histograms.clear();
        return points;
    }
    validateAndMergeLabels(type, name, labels) {
        if (!METRIC_NAME_RE.test(name)) {
            this.onError?.(new Error(`Invalid metric name: ${name}`));
            return null;
        }
        const merged = normalizeLabels({ ...this.defaultLabels, ...labels });
        const labelEntries = Object.entries(merged);
        if (labelEntries.length > this.maxLabelKeys) {
            this.onError?.(new Error(`Metric ${name} has too many label keys`));
            return null;
        }
        if (labelEntries.some(([, value]) => value.length > this.maxLabelValueLength)) {
            this.onError?.(new Error(`Metric ${name} has a label value exceeding max length`));
            return null;
        }
        const key = buildMetricKey(type, name, merged);
        if (!this.canAcceptSeries(name, key)) {
            this.onError?.(new Error(`Metric series limit exceeded for ${name}`));
            return null;
        }
        return merged;
    }
    canAcceptSeries(name, key) {
        if (this.counters.has(key) || this.gauges.has(key) || this.histograms.has(key)) {
            return true;
        }
        const currentSeries = this.counters.size + this.gauges.size + this.histograms.size;
        if (currentSeries >= this.maxSeries) {
            return false;
        }
        let nameSeries = this.metricNameSeriesCounts.get(name);
        if (!nameSeries) {
            nameSeries = new Set();
            this.metricNameSeriesCounts.set(name, nameSeries);
        }
        nameSeries.add(key);
        return true;
    }
    flushWhenFull() {
        const series = this.counters.size + this.gauges.size + this.histograms.size;
        if (series >= this.maxBatchSize) {
            void this.flush().catch((error) => this.onError?.(error));
        }
    }
    scheduleFlush() {
        this.flushTimer = this.setTimer(() => {
            void this.flush()
                .catch((error) => this.onError?.(error))
                .finally(() => {
                if (!this.closed) {
                    this.scheduleFlush();
                }
            });
        }, this.flushIntervalMs);
        this.flushTimer.unref?.();
    }
}
export function createMetricsClient(options) {
    const reporter = new MetricsReporter(options);
    return new MetricsClient({
        ...options,
        reporter,
        serviceName: options.serviceName,
    });
}
export function createDesktopReporter(options) {
    return new MetricsReporter({
        ...options,
        endpoint: resolveDesktopDomainUrl(options),
        batchPath: DESKTOP_METRICS_BATCH_PATH,
    });
}
export function buildMetricKey(type, name, labels = {}) {
    const labelText = Object.keys(labels)
        .sort()
        .map((key) => `${key}=${labels[key]}`)
        .join(',');
    return `${type}:${name}{${labelText}}`;
}
function normalizeLabels(labels) {
    return Object.fromEntries(Object.entries(labels)
        .filter(([key, value]) => key.length > 0 && value !== undefined)
        .sort(([left], [right]) => left.localeCompare(right)));
}
function normalizeBuckets(buckets) {
    return [...new Set(buckets.filter((bucket) => Number.isFinite(bucket)))].sort((a, b) => a - b);
}
function normalizeBatchPath(path) {
    const trimmed = path.trim();
    if (!trimmed)
        return DEFAULT_METRICS_BATCH_PATH;
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}
function resolveDesktopDomainUrl(options) {
    const configuredDomainUrl = options.configuredDomainUrl?.trim();
    if (configuredDomainUrl)
        return configuredDomainUrl;
    if (options.isEn) {
        if (options.isProd)
            return 'https://agent.minimax.io';
        if (options.isStaging)
            return 'https://matrix-overseas-pre.xaminim.com';
        if (options.isDev)
            return 'https://matrix-overseas-test.xaminim.com';
        return 'https://matrix-overseas-test.xaminim.com';
    }
    if (options.isProd)
        return 'https://agent.minimax.cn';
    if (options.isStaging)
        return 'https://matrix-pre.xaminim.com';
    if (options.isDev)
        return 'https://matrix-test.xaminim.com';
    return 'https://matrix-test.xaminim.com';
}
function isRetryableError(error) {
    return error instanceof MetricsReportError ? error.retryable : true;
}
function chunk(items, size) {
    const chunks = [];
    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
    }
    return chunks;
}
function toReportBody(req) {
    return {
        service: req.service,
        timestamp: req.timestamp,
        metrics: req.metrics.map((metric) => {
            if (metric.type === 'histogram') {
                return {
                    metrics_type: metric.type,
                    name: metric.name,
                    labels: metric.labels,
                    count: metric.count,
                    sum: metric.sum,
                    buckets: metric.buckets,
                    updated_at: metric.updatedAt,
                };
            }
            return {
                metrics_type: metric.type,
                name: metric.name,
                labels: metric.labels,
                value: metric.value,
                updated_at: metric.updatedAt,
            };
        }),
    };
}
//# sourceMappingURL=metrics-proxy.js.map