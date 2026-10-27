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
/**
 * Accepts exactly the origin `mavis-session-send.ts` freezes at delivery.
 *
 * Extra keys fail closed: a caller that smuggles fields past the shape must
 * not have them reach the model-facing envelope. A SideChat origin
 * (`kind: 'sidechat-send'`) has no `command` and falls out here, which keeps
 * it on its own display path instead of the peer envelope.
 */
export function parsePeerSessionOrigin(value) {
    if (!isPeerSessionOriginShape(value))
        return undefined;
    const fromAgent = optionalProtocolString(value, 'fromAgent');
    const fromTitle = optionalProtocolString(value, 'fromTitle');
    if (fromAgent === null || fromTitle === null)
        return undefined;
    return {
        fromSession: value['fromSession'],
        command: 'session send',
        ...(fromAgent !== undefined ? { fromAgent } : {}),
        ...(fromTitle !== undefined ? { fromTitle } : {}),
    };
}
const PEER_SESSION_ORIGIN_OPTIONAL_KEYS = ['fromAgent', 'fromTitle'];
function isPeerSessionOriginShape(value) {
    if (!isProtocolRecord(value))
        return false;
    const keys = [
        'fromSession',
        'command',
        ...PEER_SESSION_ORIGIN_OPTIONAL_KEYS.filter((key) => Object.hasOwn(value, key)),
    ];
    const fromSession = value['fromSession'];
    return (hasExactProtocolKeys(value, keys) &&
        value['command'] === 'session send' &&
        typeof fromSession === 'string' &&
        fromSession.trim().length > 0);
}
/** `undefined` when absent, `null` when present with the wrong type. */
function optionalProtocolString(value, key) {
    const field = value[key];
    if (field === undefined)
        return undefined;
    return typeof field === 'string' ? field : null;
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
/** Display snapshots stay on the queue message; AgentHost receives only execution metadata. */
export function parseBackgroundTaskDeliveryOrigin(value) {
    if (!isProtocolRecord(value))
        return undefined;
    const metadata = { ...value };
    delete metadata.tasks;
    return parseBackgroundTaskOriginMetadata(metadata);
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
export { isHandedBackOnClose, isTeardownDurableSteeringProducer, isUserSteeringProducer, } from './runner/contracts.js';
//# sourceMappingURL=contracts.js.map