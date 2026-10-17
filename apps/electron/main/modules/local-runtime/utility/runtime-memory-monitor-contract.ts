import { isSafeBrokerRequestId } from "./control";
export let DEFAULT_RUNTIME_MEMORY_MONITOR_INTERVAL_MS = 500;
export let MIN_RUNTIME_MEMORY_MONITOR_INTERVAL_MS = 100;
export let MAX_RUNTIME_MEMORY_MONITOR_INTERVAL_MS = 5000;
export let DEFAULT_HEAP_SAMPLING_INTERVAL_BYTES = 64 * 1024;
export let DEFAULT_HEAP_SAMPLING_STACK_DEPTH = 128;
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasOnlyKeys(value, allowed) {
    const accepted = new Set(allowed);
    return Object.keys(value).every((key) => accepted.has(key));
}
function isNonNegativeSafeInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function isPositiveSafeInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function isMonitorInterval(value) {
    return (isPositiveSafeInteger(value) &&
        value >= MIN_RUNTIME_MEMORY_MONITOR_INTERVAL_MS &&
        value <= MAX_RUNTIME_MEMORY_MONITOR_INTERVAL_MS);
}
function isSamplingInterval(value) {
    return isPositiveSafeInteger(value) && value >= 4 * 1024 && value <= 1024 * 1024;
}
function isStackDepth(value) {
    return isPositiveSafeInteger(value) && value >= 16 && value <= 256;
}
export function isRuntimeMemoryMonitorCommand(value) {
    if (!isRecord(value) || !isSafeBrokerRequestId(value.requestId))
        return false;
    switch (value.type) {
        case 'runtime-memory-monitor-configure':
            return (hasOnlyKeys(value, ['type', 'requestId', 'enabled', 'intervalMs']) &&
                typeof value.enabled === 'boolean' &&
                isMonitorInterval(value.intervalMs));
        case 'runtime-heap-sampling-start':
            return (hasOnlyKeys(value, ['type', 'requestId', 'samplingIntervalBytes', 'stackDepth']) &&
                isSamplingInterval(value.samplingIntervalBytes) &&
                isStackDepth(value.stackDepth));
        case 'runtime-heap-sampling-stop':
            return hasOnlyKeys(value, ['type', 'requestId']);
        default:
            return false;
    }
}
export function isRuntimeMemorySampleMessage(value) {
    if (!isRecord(value) || value.type !== 'runtime-memory-sample')
        return false;
    return (hasOnlyKeys(value, [
        'type',
        'sequence',
        'timestampMs',
        'heapUsedBytes',
        'heapTotalBytes',
        'heapSizeLimitBytes',
        'rssBytes',
        'externalBytes',
        'arrayBuffersBytes',
    ]) &&
        isNonNegativeSafeInteger(value.sequence) &&
        isNonNegativeSafeInteger(value.timestampMs) &&
        isNonNegativeSafeInteger(value.heapUsedBytes) &&
        isNonNegativeSafeInteger(value.heapTotalBytes) &&
        isPositiveSafeInteger(value.heapSizeLimitBytes) &&
        isNonNegativeSafeInteger(value.rssBytes) &&
        isNonNegativeSafeInteger(value.externalBytes) &&
        isNonNegativeSafeInteger(value.arrayBuffersBytes));
}
const ERROR_CODES = new Set([
    'runtime_not_ready',
    'already_sampling',
    'not_sampling',
    'profiler_failed',
    'profile_write_failed',
    'invalid_request',
]);
export function isRuntimeMemoryMonitorResponse(value) {
    if (!isRecord(value) || !isSafeBrokerRequestId(value.requestId))
        return false;
    switch (value.type) {
        case 'runtime-memory-monitor-configured':
            return (hasOnlyKeys(value, ['type', 'requestId', 'enabled', 'intervalMs']) &&
                typeof value.enabled === 'boolean' &&
                isMonitorInterval(value.intervalMs));
        case 'runtime-heap-sampling-started':
            return (hasOnlyKeys(value, [
                'type',
                'requestId',
                'startedAtMs',
                'samplingIntervalBytes',
                'stackDepth',
            ]) &&
                isNonNegativeSafeInteger(value.startedAtMs) &&
                isSamplingInterval(value.samplingIntervalBytes) &&
                isStackDepth(value.stackDepth));
        case 'runtime-heap-sampling-stopped':
            return (hasOnlyKeys(value, [
                'type',
                'requestId',
                'startedAtMs',
                'stoppedAtMs',
                'profilePath',
                'sampleCount',
                'sampledBytes',
            ]) &&
                isNonNegativeSafeInteger(value.startedAtMs) &&
                isNonNegativeSafeInteger(value.stoppedAtMs) &&
                value.stoppedAtMs >= value.startedAtMs &&
                typeof value.profilePath === 'string' &&
                value.profilePath.length > 0 &&
                value.profilePath.length <= 4096 &&
                isNonNegativeSafeInteger(value.sampleCount) &&
                isNonNegativeSafeInteger(value.sampledBytes));
        case 'runtime-memory-monitor-error':
            return (hasOnlyKeys(value, ['type', 'requestId', 'code']) &&
                typeof value.code === 'string' &&
                ERROR_CODES.has(value.code));
        default:
            return false;
    }
}
