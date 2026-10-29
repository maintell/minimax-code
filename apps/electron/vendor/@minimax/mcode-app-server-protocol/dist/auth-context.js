/** Validate and copy a Desktop-owned auth snapshot at the process boundary. */
export function decodeAppServerRuntimeAuthContext(value) {
    if (!isRecord(value)) {
        return { ok: false, message: 'Runtime auth context must be an object.' };
    }
    const authState = value.authState;
    if (authState !== 'pending' && authState !== 'authenticated' && authState !== 'logged_out') {
        return { ok: false, message: 'Runtime auth context contains an invalid authState.' };
    }
    const accessToken = decodeOptionalAuthString(value.accessToken, 1024 * 1024);
    const realUserID = decodeOptionalAuthString(value.realUserID, 16 * 1024);
    const userEmail = decodeOptionalAuthString(value.userEmail, 16 * 1024);
    const userName = decodeOptionalAuthString(value.userName, 16 * 1024);
    const subUserName = decodeOptionalAuthString(value.subUserName, 16 * 1024);
    const expiresAtMs = value.expiresAtMs;
    if (expiresAtMs !== undefined &&
        (typeof expiresAtMs !== 'number' ||
            !Number.isSafeInteger(expiresAtMs) ||
            expiresAtMs <= 0 ||
            authState !== 'authenticated')) {
        return { ok: false, message: 'Runtime auth context contains an invalid token expiry.' };
    }
    if (!accessToken.ok || !realUserID.ok || !userEmail.ok || !userName.ok || !subUserName.ok) {
        return { ok: false, message: 'Runtime auth context contains an invalid identity field.' };
    }
    if (authState === 'logged_out' && (accessToken.value || realUserID.value)) {
        return { ok: false, message: 'Logged-out Runtime auth context cannot contain credentials.' };
    }
    if (authState === 'authenticated' && (!accessToken.value || !realUserID.value)) {
        return {
            ok: false,
            message: 'Authenticated Runtime auth context requires an access token and user id.',
        };
    }
    return {
        ok: true,
        context: {
            authState,
            ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
            ...(accessToken.value ? { accessToken: accessToken.value } : {}),
            ...(realUserID.value ? { realUserID: realUserID.value } : {}),
            ...(userEmail.value ? { userEmail: userEmail.value } : {}),
            ...(userName.value ? { userName: userName.value } : {}),
            ...(subUserName.value ? { subUserName: subUserName.value } : {}),
        },
    };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function decodeOptionalAuthString(value, maxLength) {
    if (value === undefined || value === null || value === '')
        return { ok: true };
    if (typeof value !== 'string' || value.length > maxLength)
        return { ok: false };
    const trimmed = value.trim();
    return trimmed ? { ok: true, value: trimmed } : { ok: false };
}
//# sourceMappingURL=auth-context.js.map