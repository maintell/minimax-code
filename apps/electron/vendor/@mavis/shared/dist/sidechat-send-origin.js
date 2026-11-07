export function sideChatSendOrigin(sideChatSessionId) {
    return { kind: 'sidechat-send', sideChatSessionId };
}
/** Lenient on extra fields so a newer writer never makes an older reader drop the label. */
export function isSideChatSendOrigin(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    const origin = value;
    return (origin.kind === 'sidechat-send' &&
        typeof origin.sideChatSessionId === 'string' &&
        origin.sideChatSessionId.length > 0);
}
//# sourceMappingURL=sidechat-send-origin.js.map