import { parseBackgroundTaskOriginMetadata, } from '../contracts/history.js';
export { BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE, BACKGROUND_TASK_READ_SETTLEMENT_CUSTOM_TYPE, hasValidBackgroundTaskHostMetadata, isBackgroundTaskReadSettlement, parseBackgroundTaskOriginMetadata, readBackgroundTaskOriginMetadata, } from '../contracts/history.js';
/**
 * Hidden messages the Turn state layer writes into canonical history; compaction, rewind and
 * history identity tell them apart by these types.
 */
export { isRecallPointersMessage, isStateDeltaMessage, } from './execution/turn-state-layer/hidden-messages.js';
/**
 * Accepts exactly the origin `mavis-session-send.ts` freezes at delivery.
 *
 * Extra keys fail closed: a caller that smuggles fields past the shape must
 * not have them reach the model-facing envelope.
 *
 * A SideChat hand-back to its main Session is stored with a SideChat origin
 * (`kind: 'sidechat-send'`) so the desktop can label its bubble. For the model
 * it is still a message from another local Session that may need an answer, so
 * it reads as a peer origin naming the SideChat: the main Session gets the same
 * envelope and reply note as any other session send. Display keeps reading the
 * stored SideChat origin.
 */
export function parsePeerSessionOrigin(value) {
    const sideChatSessionId = sideChatHandBackSender(value);
    if (sideChatSessionId)
        return { fromSession: sideChatSessionId, command: 'session send' };
    if (!isPeerSessionOriginShape(value))
        return undefined;
    const fromAgent = optionalProtocolString(value, 'fromAgent');
    const fromTitle = optionalProtocolString(value, 'fromTitle');
    const fromDevice = optionalProtocolString(value, 'fromDevice');
    if (fromAgent === null || fromTitle === null || fromDevice === null)
        return undefined;
    return {
        fromSession: value['fromSession'],
        command: 'session send',
        ...(fromAgent !== undefined ? { fromAgent } : {}),
        ...(fromTitle !== undefined ? { fromTitle } : {}),
        ...(fromDevice !== undefined ? { fromDevice } : {}),
        ...(value['remote'] === true ? { remote: true } : {}),
    };
}
/**
 * The SideChat id of a stored SideChat hand-back origin
 * (`@mavis/shared/sidechat-send-origin`, read by shape because the AgentHost
 * core stays self-contained). Lenient on extra keys like the shared reader.
 */
function sideChatHandBackSender(value) {
    if (!isProtocolRecord(value) || value['kind'] !== 'sidechat-send')
        return undefined;
    const id = value['sideChatSessionId'];
    return typeof id === 'string' && id.trim().length > 0 ? id : undefined;
}
const PEER_SESSION_ORIGIN_OPTIONAL_KEYS = [
    'fromAgent',
    'fromTitle',
    'fromDevice',
    'remote',
];
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
        fromSession.trim().length > 0 &&
        // Only `remote: true` is accepted, so a sender on this runtime cannot mark itself remote by accident.
        (!Object.hasOwn(value, 'remote') || value['remote'] === true));
}
/** `undefined` when absent, `null` when present with the wrong type. */
function optionalProtocolString(value, key) {
    const field = value[key];
    if (field === undefined)
        return undefined;
    return typeof field === 'string' ? field : null;
}
/**
 * Display snapshots and the IM reply address stay on the queue message (the final-reply
 * observer reads the address from the Turn's source); AgentHost receives only execution
 * metadata.
 */
export function parseBackgroundTaskDeliveryOrigin(value) {
    if (!isProtocolRecord(value))
        return undefined;
    const metadata = { ...value };
    delete metadata.tasks;
    delete metadata.replyChannel;
    return parseBackgroundTaskOriginMetadata(metadata);
}
function hasExactProtocolKeys(value, keys) {
    const actual = Object.keys(value);
    return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function isProtocolRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
//# sourceMappingURL=contracts.js.map