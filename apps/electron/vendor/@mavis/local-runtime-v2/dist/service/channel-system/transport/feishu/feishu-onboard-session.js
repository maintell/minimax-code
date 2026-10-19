export function serialize(session, now) {
    const expiresInSec = Math.max(0, Math.ceil((session.expiresAtMs - now) / 1000));
    const userExpiresInSec = session.userExpiresAtMs
        ? Math.max(0, Math.ceil((session.userExpiresAtMs - now) / 1000))
        : undefined;
    return {
        sessionId: session.sessionId,
        connectionId: session.connectionId,
        status: session.status,
        verificationUriComplete: session.verificationUriComplete,
        userCode: session.userCode,
        expiresIn: expiresInSec,
        expiresInSec,
        intervalSec: session.intervalSec,
        skipUserAuth: session.skipUserAuth,
        appId: session.appId,
        botBound: session.botBound === true,
        userOpenId: session.userOpenId,
        userName: session.userName,
        userVerificationUriComplete: session.userVerificationUriComplete,
        userCodeFromCli: session.userCodeFromCli,
        userExpiresInSec,
        userIntervalSec: session.userIntervalSec,
        error: session.error,
    };
}
export function parseJsonObject(text) {
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : {};
    }
    catch {
        return {};
    }
}
export function readRecord(value, key) {
    const nested = value[key];
    return nested && typeof nested === 'object' && !Array.isArray(nested)
        ? nested
        : undefined;
}
export function readString(value, key) {
    const raw = value[key];
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
}
export function readNumber(value, key) {
    const raw = value[key];
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}
export function readPositiveNumber(value, key) {
    const number = readNumber(value, key);
    return number !== undefined && number > 0 ? number : undefined;
}
export function isPendingText(text) {
    const lower = text.toLowerCase();
    return lower.includes('authorization_pending') || lower.includes('slow_down');
}
//# sourceMappingURL=feishu-onboard-session.js.map