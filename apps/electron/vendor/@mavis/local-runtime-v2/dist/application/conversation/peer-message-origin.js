const REMOTE_SENDER_FIELDS = ['fromDevice', 'fromTitle', 'fromAgent'];
/**
 * Project persisted peer attribution without exposing the rest of its routing
 * context. A message from another device (`remote: true`, the only value
 * accepted, as in `parsePeerSessionOrigin`) also carries the sender's device,
 * title and Agent when they are strings, so its bubble names the other device
 * instead of opening a session here. A message from this runtime keeps
 * `fromSession` and `command` only.
 */
export function projectPeerMessageOrigin(message) {
    if (message.source !== 'communication')
        return undefined;
    const context = message.sourceContext ?? message.source_context;
    if (!isRecord(context) || !isRecord(context.origin))
        return undefined;
    const { origin } = context;
    const { fromSession, command } = origin;
    if (typeof fromSession !== 'string' || !fromSession.trim())
        return undefined;
    return {
        fromSession,
        ...(typeof command === 'string' ? { command } : {}),
        ...(origin.remote === true ? remoteSender(origin) : {}),
    };
}
function remoteSender(origin) {
    const sender = { remote: true };
    for (const field of REMOTE_SENDER_FIELDS) {
        const value = origin[field];
        if (typeof value === 'string')
            sender[field] = value;
    }
    return sender;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=peer-message-origin.js.map