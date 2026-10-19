const TIMESTAMP_ERROR_FRAGMENT = 'message.timestamp must be finite';
const TIMESTAMP_ERROR_KIND = 'canonical-history-message-timestamp';
const LEGACY_HISTORY_TIMESTAMP_COMPAT_VERSION = 1;
export function normalizeLegacyHistoryTimestamp(value, stableFallback) {
    const container = isRecord(value) ? value : undefined;
    const envelope = container && isCanonicalEnvelopeShape(container) ? container : undefined;
    const message = envelope?.['message'] ?? container;
    if (!isRecord(message))
        return value;
    const timestamp = legacyTimestampMs(message['timestamp']) ?? legacyTimestampMs(stableFallback);
    if (timestamp === undefined || message['timestamp'] === timestamp)
        return value;
    const normalizedMessage = { ...message, timestamp };
    return envelope ? { ...envelope, message: normalizedMessage } : normalizedMessage;
}
export function isCanonicalEnvelopeShape(value) {
    return (Object.hasOwn(value, 'message_id') &&
        Object.hasOwn(value, 'turn_id') &&
        isRecord(value['message']));
}
export function shouldRetryLegacyHistoryTimestampFailure(record, historyRequested) {
    return Boolean(historyRequested &&
        record?.status === 'failed' &&
        isLegacyHistoryTimestampFailure(record.error) &&
        legacyHistoryTimestampCompatVersion(record) < LEGACY_HISTORY_TIMESTAMP_COMPAT_VERSION);
}
export function legacyHistoryTimestampFailureMetadata(error, retryAttempted) {
    const knownTimestampFailure = isLegacyHistoryTimestampFailure(error);
    if (!knownTimestampFailure && !retryAttempted)
        return {};
    return {
        ...(knownTimestampFailure ? { kind: TIMESTAMP_ERROR_KIND } : {}),
        ...(retryAttempted ? { compatRetryVersion: LEGACY_HISTORY_TIMESTAMP_COMPAT_VERSION } : {}),
    };
}
export function legacyHistoryTimestampCompatReport(previous, retriedAtMs, result) {
    return {
        ...(isRecord(previous) ? previous : {}),
        legacyHistoryTimestampCompat: {
            version: LEGACY_HISTORY_TIMESTAMP_COMPAT_VERSION,
            retriedAtMs,
            result,
        },
    };
}
function legacyTimestampMs(value) {
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : undefined;
    if (typeof value !== 'string')
        return undefined;
    const numeric = Number(value);
    if (Number.isFinite(numeric))
        return numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function isLegacyHistoryTimestampFailure(value) {
    const pending = [value];
    const visited = new Set();
    while (pending.length > 0) {
        const candidate = pending.pop();
        if (candidate === undefined || candidate === null || visited.has(candidate))
            continue;
        visited.add(candidate);
        if (collectTimestampFailureEvidence(candidate, pending))
            return true;
    }
    return false;
}
function collectTimestampFailureEvidence(candidate, pending) {
    if (typeof candidate === 'string')
        return candidate.includes(TIMESTAMP_ERROR_FRAGMENT);
    if (candidate instanceof AggregateError)
        pending.push(...candidate.errors);
    if (candidate instanceof Error)
        pending.push(candidate.message, candidate.cause);
    if (!isRecord(candidate))
        return false;
    if (candidate['kind'] === TIMESTAMP_ERROR_KIND)
        return true;
    pending.push(candidate['message'], candidate['cause'], candidate['error']);
    return false;
}
function legacyHistoryTimestampCompatVersion(record) {
    const errorVersion = nestedNumber(record.error, 'compatRetryVersion');
    const reportVersion = isRecord(record.report)
        ? nestedNumber(record.report['legacyHistoryTimestampCompat'], 'version')
        : 0;
    return Math.max(errorVersion, reportVersion);
}
function nestedNumber(value, key) {
    if (!isRecord(value))
        return 0;
    const candidate = value[key];
    return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : 0;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=legacy-history-timestamp.js.map