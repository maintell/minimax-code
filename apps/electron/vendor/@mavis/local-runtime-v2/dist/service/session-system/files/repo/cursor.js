export function encodeAssetCursor(row) {
    return Buffer.from(JSON.stringify({
        v: 1,
        k: 'asset',
        s: row.sessionId,
        c: row.messageCreatedAtMs,
        i: row.id,
    })).toString('base64url');
}
export function decodeAssetCursor(value, sessionId) {
    if (!value)
        return undefined;
    try {
        const parsed = JSON.parse(Buffer.from(value, 'base64url').toString());
        return isAssetCursor(parsed, sessionId)
            ? { messageCreatedAtMs: parsed.c, id: parsed.i }
            : undefined;
    }
    catch {
        return undefined;
    }
}
function isAssetCursor(value, sessionId) {
    if (typeof value !== 'object' || value === null)
        return false;
    const record = value;
    return (record.v === 1 &&
        record.k === 'asset' &&
        record.s === sessionId &&
        Number.isSafeInteger(record.c) &&
        Number.isSafeInteger(record.i) &&
        record.i > 0);
}
//# sourceMappingURL=cursor.js.map