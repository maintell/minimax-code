export const BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE = 'background_task_cadence_reminder';
export const BACKGROUND_TASK_READ_SETTLEMENT_CUSTOM_TYPE = 'background_task_read_settlement';
/** Reads current nested metadata and the pre-hostMetadata persisted shape. */
export function readBackgroundTaskOriginMetadata(message) {
    if (!isProtocolRecord(message))
        return undefined;
    const hostMetadata = readProtocolRecord(message['hostMetadata']);
    return (parseBackgroundTaskOriginMetadata(hostMetadata?.['backgroundTaskOrigin']) ??
        parseBackgroundTaskOriginMetadata(message['backgroundTaskOrigin']));
}
export function hasValidBackgroundTaskHostMetadata(message) {
    const current = Object.hasOwn(message, 'hostMetadata');
    const legacy = Object.hasOwn(message, 'backgroundTaskOrigin');
    if (!current && !legacy)
        return true;
    if (current && legacy)
        return false;
    if (current) {
        const metadata = readProtocolRecord(Reflect.get(message, 'hostMetadata'));
        return (metadata !== undefined &&
            hasExactProtocolKeys(metadata, ['backgroundTaskOrigin']) &&
            parseBackgroundTaskOriginMetadata(metadata['backgroundTaskOrigin']) !== undefined);
    }
    return (parseBackgroundTaskOriginMetadata(Reflect.get(message, 'backgroundTaskOrigin')) !== undefined);
}
export function isBackgroundTaskReadSettlement(message) {
    if (!isProtocolRecord(message))
        return false;
    return (hasExactProtocolKeys(message, [
        'role',
        'customType',
        'content',
        'display',
        'details',
        'hostMetadata',
        'timestamp',
    ]) &&
        isBackgroundTaskReadSettlementEnvelope(message) &&
        isBackgroundTaskReadSettlementDetails(message['details']) &&
        isProviderOmitHostMetadata(message['hostMetadata']));
}
function isBackgroundTaskReadSettlementEnvelope(message) {
    return (message['role'] === 'custom' &&
        message['customType'] === BACKGROUND_TASK_READ_SETTLEMENT_CUSTOM_TYPE &&
        message['content'] === '' &&
        message['display'] === false &&
        Number.isFinite(message['timestamp']));
}
function isBackgroundTaskReadSettlementDetails(value) {
    return (isProtocolRecord(value) && hasExactProtocolKeys(value, ['version']) && value['version'] === 1);
}
function isProviderOmitHostMetadata(value) {
    return (isProtocolRecord(value) &&
        hasExactProtocolKeys(value, ['providerVisibility']) &&
        value['providerVisibility'] === 'omit');
}
export function parseBackgroundTaskOriginMetadata(value) {
    if (!isProtocolRecord(value))
        return undefined;
    const hasCount = Object.hasOwn(value, 'observedTerminalCount');
    if (!hasExactProtocolKeys(value, hasCount ? ['kind', 'taskIds', 'observedTerminalCount'] : ['kind', 'taskIds']) ||
        value['kind'] !== 'background-task-terminal') {
        return undefined;
    }
    const taskIds = readNonEmptyTaskIds(value['taskIds']);
    const observedTerminalCount = readOptionalTerminalCount(value['observedTerminalCount'], hasCount);
    if (!taskIds || observedTerminalCount === null)
        return undefined;
    return {
        kind: 'background-task-terminal',
        taskIds,
        ...(observedTerminalCount === undefined ? {} : { observedTerminalCount }),
    };
}
function readNonEmptyTaskIds(value) {
    if (!Array.isArray(value) ||
        value.length === 0 ||
        value.some((taskId) => typeof taskId !== 'string' || !taskId.trim())) {
        return undefined;
    }
    return [...value];
}
function readOptionalTerminalCount(value, present) {
    if (!present)
        return undefined;
    return isNonNegativeSafeInteger(value) ? Number(value) : null;
}
function hasExactProtocolKeys(value, keys) {
    const actual = Object.keys(value);
    return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function isNonNegativeSafeInteger(value) {
    return Number.isSafeInteger(value) && Number(value) >= 0;
}
function isProtocolRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function readProtocolRecord(value) {
    return isProtocolRecord(value) ? value : undefined;
}
export { isUserSteeringProducer } from './runner/contracts.js';
//# sourceMappingURL=contracts.js.map