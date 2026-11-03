/** Message persistence was cancelled before its write transaction began. */
export class MessageWriteWaitAbortedError extends Error {
    signal;
    name = 'MessageWriteWaitAbortedError';
    constructor(signal) {
        super('Message write wait was cancelled', { cause: signal.reason });
        this.signal = signal;
    }
}
/**
 * Display kind of a user side message the runtime received but could neither
 * steer into a Turn nor queue while a Goal was active. It has no Turn id, so it
 * never becomes canonical context; it stays until it is retried or discarded.
 */
export const UNDELIVERED_USER_MESSAGE_KIND = 'undelivered_user';
export class MessageDataCorruptionError extends Error {
    sessionId;
    messageId;
    constructor(sessionId, messageId) {
        super(`Display message row is corrupt: ${sessionId}/${messageId}`);
        this.sessionId = sessionId;
        this.messageId = messageId;
        this.name = 'MessageDataCorruptionError';
    }
}
export class UserMessageCommitConflictError extends Error {
    sessionId;
    messageId;
    name = 'UserMessageCommitConflictError';
    code = 'USER_MESSAGE_COMMIT_CONFLICT';
    constructor(sessionId, messageId) {
        super(`Committed user message payload changed: ${sessionId}/${messageId}`);
        this.sessionId = sessionId;
        this.messageId = messageId;
    }
}
export class UserMessageCommitAdmissionError extends Error {
    sessionId;
    reason;
    name = 'UserMessageCommitAdmissionError';
    constructor(sessionId, reason) {
        super(`User message commit rejected: ${sessionId}/${reason}`);
        this.sessionId = sessionId;
        this.reason = reason;
    }
}
//# sourceMappingURL=contract.js.map