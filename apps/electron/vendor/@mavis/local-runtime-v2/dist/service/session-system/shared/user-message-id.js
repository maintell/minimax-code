import { createHash } from 'node:crypto';
const USER_MESSAGE_ID_PREFIX = 'msg-user-v1-';
const USER_MESSAGE_ID_RE = /^msg-user-v1-[A-Za-z0-9_-]+$/;
export function createUserMessageId(input) {
    if (!input.sessionId)
        throw new Error('sessionId is required');
    if (!input.messageKey)
        throw new Error('messageKey is required');
    const digest = createHash('sha256')
        .update(input.sessionId)
        .update('\0')
        .update(input.messageKey)
        .digest('base64url');
    return `${USER_MESSAGE_ID_PREFIX}${digest}`;
}
export function parseUserMessageId(value) {
    return typeof value === 'string' && USER_MESSAGE_ID_RE.test(value)
        ? value
        : undefined;
}
export function isUserMessageId(value) {
    return parseUserMessageId(value) !== undefined;
}
//# sourceMappingURL=user-message-id.js.map