export function sanitizeCanonicalTurnModel(model) {
    return Object.fromEntries(Object.entries(model).filter(([key]) => !isSensitiveModelKey(key)));
}
function isSensitiveModelKey(key) {
    return [
        'apikey',
        'authorization',
        'token',
        'accesstoken',
        'secret',
        'password',
        'credential',
    ].includes(key.replaceAll(/[_-]/gu, '').toLowerCase());
}
//# sourceMappingURL=history-store.js.map