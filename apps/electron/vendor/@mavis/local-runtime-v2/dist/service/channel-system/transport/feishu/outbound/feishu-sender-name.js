export async function enrichFeishuSenderName(body, sender) {
    const payload = isRecord(body.payload) ? body.payload : body;
    const event = isRecord(payload.event) ? payload.event : payload;
    const currentSender = isRecord(event.sender) ? event.sender : undefined;
    if (!currentSender ||
        readFirstString(currentSender, ['senderName', 'sender_name', 'name', 'nickname'])) {
        return body;
    }
    const senderId = isRecord(currentSender.sender_id) ? currentSender.sender_id : {};
    const openId = readFirstString(senderId, ['open_id']);
    if (!openId)
        return body;
    currentSender.sender_name = (await lookupDisplayName(sender, openId)) ?? openId.slice(-6);
    return body;
}
/** Best-effort profile lookup; a directory failure falls back to the id tail. */
async function lookupDisplayName(sender, openId) {
    try {
        return await sender.getUserDisplayName(openId);
    }
    catch {
        return undefined;
    }
}
function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
function readFirstString(value, keys) {
    for (const key of keys) {
        const raw = value[key];
        if (typeof raw === 'string' && raw.trim())
            return raw.trim();
    }
    return undefined;
}
//# sourceMappingURL=feishu-sender-name.js.map