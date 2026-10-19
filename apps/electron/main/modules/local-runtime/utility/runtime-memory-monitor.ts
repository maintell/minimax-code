import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Session } from "node:inspector";
import { getHeapStatistics } from "node:v8";
import { isRuntimeMemoryMonitorCommand } from "./runtime-memory-monitor-contract";
const PROFILE_DIRECTORY_NAME = 'heap-profiles';
function safeProfileTimestamp(timestampMs) {
    return new Date(timestampMs).toISOString().replace(/[:.]/g, '-');
}
function isSamplingProfileResult(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const profile = Reflect.get(value, 'profile');
    return typeof profile === 'object' && profile !== null;
}
function profileSummary(profile) {
    const samples = Array.isArray(profile.samples) ? profile.samples : [];
    let sampledBytes = 0;
    for (const sample of samples) {
        const size = sample?.size;
        if (typeof size === 'number' && Number.isSafeInteger(size) && size > 0)
            sampledBytes += size;
    }
    return { sampleCount: samples.length, sampledBytes };
}
export class UtilityRuntimeMemoryMonitor {
    constructor(options) {
        this.options = options;
        this.outputDirectory = null;
        this.sampleTimer = null;
        this.sampleSequence = 0;
        this.activeHeapSampling = null;
    }
    setOutputDirectory(directory) {
        this.outputDirectory = directory;
    }
    handleMessage(value) {
        if (typeof value !== 'object' ||
            value === null ||
            !String(Reflect.get(value, 'type') ?? '').startsWith('runtime-')) {
            return false;
        }
        const type = Reflect.get(value, 'type');
        if (type !== 'runtime-memory-monitor-configure' &&
            type !== 'runtime-heap-sampling-start' &&
            type !== 'runtime-heap-sampling-stop') {
            return false;
        }
        if (!isRuntimeMemoryMonitorCommand(value)) {
            const requestId = Reflect.get(value, 'requestId');
            if (typeof requestId === 'string' && requestId.length > 0) {
                this.postError(requestId, 'invalid_request');
            }
            return true;
        }
        if (value.type === 'runtime-memory-monitor-configure') {
            this.configure(value.enabled, value.intervalMs);
            this.options.postMessage({
                type: 'runtime-memory-monitor-configured',
                requestId: value.requestId,
                enabled: value.enabled,
                intervalMs: value.intervalMs,
            });
            return true;
        }
        if (value.type === 'runtime-heap-sampling-start') {
            void this.startHeapSampling(value);
            return true;
        }
        void this.stopHeapSampling(value.requestId);
        return true;
    }
    dispose() {
        this.configure(false, 500);
        const active = this.activeHeapSampling;
        this.activeHeapSampling = null;
        if (!active)
            return;
        try {
            active.session.disconnect();
        }
        catch {
            // The utility process is already draining; sampling data is intentionally discarded.
        }
    }
    configure(enabled, intervalMs) {
        if (this.sampleTimer) {
            clearInterval(this.sampleTimer);
            this.sampleTimer = null;
        }
        if (!enabled)
            return;
        this.reportSample();
        this.sampleTimer = setInterval(() => this.reportSample(), intervalMs);
        this.sampleTimer.unref?.();
    }
    reportSample() {
        try {
            const memory = (this.options.memoryUsage ?? process.memoryUsage)();
            const heapSizeLimitBytes = Math.max(1, Math.trunc((this.options.heapSizeLimit ?? (() => getHeapStatistics().heap_size_limit))()));
            this.options.postMessage({
                type: 'runtime-memory-sample',
                sequence: this.sampleSequence,
                timestampMs: (this.options.nowMs ?? Date.now)(),
                heapUsedBytes: memory.heapUsed,
                heapTotalBytes: memory.heapTotal,
                heapSizeLimitBytes,
                rssBytes: memory.rss,
                externalBytes: memory.external,
                arrayBuffersBytes: memory.arrayBuffers,
            });
            this.sampleSequence += 1;
        }
        catch {
            // Developer-only observation must never affect the runtime lifecycle.
        }
    }
    async startHeapSampling(message) {
        if (this.activeHeapSampling) {
            this.postError(message.requestId, 'already_sampling');
            return;
        }
        if (!this.outputDirectory) {
            this.postError(message.requestId, 'runtime_not_ready');
            return;
        }
        const session = (this.options.createInspectorSession ??
            (() => new Session()))();
        try {
            session.connect();
            await this.postInspector(session, 'HeapProfiler.enable');
            await this.postInspector(session, 'HeapProfiler.startSampling', {
                samplingInterval: message.samplingIntervalBytes,
                stackDepth: message.stackDepth,
                includeObjectsCollectedByMajorGC: true,
                includeObjectsCollectedByMinorGC: true,
            });
            const startedAtMs = (this.options.nowMs ?? Date.now)();
            this.activeHeapSampling = {
                session,
                startedAtMs,
                samplingIntervalBytes: message.samplingIntervalBytes,
                stackDepth: message.stackDepth,
            };
            this.options.postMessage({
                type: 'runtime-heap-sampling-started',
                requestId: message.requestId,
                startedAtMs,
                samplingIntervalBytes: message.samplingIntervalBytes,
                stackDepth: message.stackDepth,
            });
        }
        catch {
            try {
                session.disconnect();
            }
            catch {
                // Ignore teardown races.
            }
            this.postError(message.requestId, 'profiler_failed');
        }
    }
    async stopHeapSampling(requestId) {
        const active = this.activeHeapSampling;
        if (!active) {
            this.postError(requestId, 'not_sampling');
            return;
        }
        this.activeHeapSampling = null;
        let result;
        try {
            result = await this.postInspector(active.session, 'HeapProfiler.stopSampling');
        }
        catch {
            try {
                active.session.disconnect();
            }
            catch {
                // Ignore teardown races.
            }
            this.postError(requestId, 'profiler_failed');
            return;
        }
        try {
            await this.postInspector(active.session, 'HeapProfiler.disable');
        }
        catch {
            // stopSampling already returned the profile; disabling is best-effort teardown.
        }
        try {
            active.session.disconnect();
        }
        catch {
            // The profile is already collected; disconnect failure is non-terminal.
        }
        if (!isSamplingProfileResult(result) || !this.outputDirectory) {
            this.postError(requestId, 'profiler_failed');
            return;
        }
        const stoppedAtMs = (this.options.nowMs ?? Date.now)();
        const profileDirectory = join(this.outputDirectory, PROFILE_DIRECTORY_NAME);
        const profilePath = join(profileDirectory, `local-runtime-${safeProfileTimestamp(stoppedAtMs)}.heapprofile`);
        try {
            await (this.options.mkdir ?? mkdir)(profileDirectory, { recursive: true });
            await (this.options.writeFile ?? writeFile)(profilePath, JSON.stringify(result.profile));
        }
        catch {
            this.postError(requestId, 'profile_write_failed');
            return;
        }
        const summary = profileSummary(result.profile);
        this.options.postMessage({
            type: 'runtime-heap-sampling-stopped',
            requestId,
            startedAtMs: active.startedAtMs,
            stoppedAtMs,
            profilePath,
            ...summary,
        });
    }
    postInspector(session, method, params) {
        return new Promise((resolve, reject) => {
            session.post(method, params, (error, result) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(result ?? {});
            });
        });
    }
    postError(requestId, code) {
        this.options.postMessage({ type: 'runtime-memory-monitor-error', requestId, code });
    }
}

