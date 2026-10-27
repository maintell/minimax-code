/** Project persisted peer attribution without exposing the rest of its routing context. */
export function projectPeerMessageOrigin(message) {
    if (message.source !== 'communication')
        return undefined;
    const context = message.sourceContext ?? message.source_context;
    if (!isRecord(context) || !isRecord(context.origin))
        return undefined;
    const { fromSession, command } = context.origin;
    if (typeof fromSession !== 'string' || !fromSession.trim())
        return undefined;
    return {
        fromSession,
        ...(typeof command === 'string' ? { command } : {}),
    };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=peer-message-origin.js.map