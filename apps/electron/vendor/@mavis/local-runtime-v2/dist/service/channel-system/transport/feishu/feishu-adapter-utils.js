/**
 * Migration copy (MR1) of v1 `channels/adapters/feishu/feishu-adapter-utils.ts`.
 */
/**
 * Shared tiny utilities lifted from `feishu-adapter.ts` to keep the adapter
 * file under the 500-line layout budget. Pure functions only — no side
 * effects, no I/O. Anything that touches the store or the sender stays in
 * the adapter itself.
 */
/** A disabled, disconnected, or historical mock row is not a live transport. */
export function isUsableFeishuBinding(record) {
    if (!record?.enabled || !record.connected || record.mode === 'mock')
        return false;
    return Boolean(record.appId.trim() && record.appSecret.trim());
}
export function pickString(record, keys) {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim())
            return value.trim();
    }
    return undefined;
}
/** Bind-time modes are real transports only. Historical mock records are
 * normalised by the persisted-store reader and remain disabled there. */
export function normalizeMode(value) {
    const normalized = value?.toLowerCase().trim();
    if (normalized === 'webhook')
        return 'webhook';
    if (normalized === 'websocket' || normalized === 'ws')
        return 'websocket';
    return 'websocket';
}
export function errorMessage(err) {
    if (err instanceof Error)
        return err.message;
    return String(err);
}
/** Credential + mode gates for bind(); mock mode is rejected outright. */
export function validateFeishuBindCredentials(credentials, clientName) {
    const appId = pickString(credentials, ['appId', 'app_id']);
    const appSecret = pickString(credentials, ['appSecret', 'app_secret']);
    if (!appId || !appSecret) {
        return {
            error: {
                ok: false,
                clientName,
                error: 'appId and appSecret are required',
                code: 'VALIDATION_ERROR',
            },
        };
    }
    const requestedMode = pickString(credentials, ['mode'])?.toLowerCase();
    if (requestedMode === 'mock') {
        return {
            error: {
                ok: false,
                clientName,
                error: 'mock channel mode is not supported',
                code: 'CHANNEL_MOCK_MODE_UNSUPPORTED',
            },
        };
    }
    if (requestedMode && !['webhook', 'websocket', 'ws'].includes(requestedMode)) {
        return {
            error: {
                ok: false,
                clientName,
                error: 'unsupported channel mode',
                code: 'VALIDATION_ERROR',
            },
        };
    }
    return { appId, appSecret, mode: normalizeMode(requestedMode) };
}
export function sameWsCredentials(left, right) {
    return left?.appId === right.appId && left.appSecret === right.appSecret;
}
//# sourceMappingURL=feishu-adapter-utils.js.map