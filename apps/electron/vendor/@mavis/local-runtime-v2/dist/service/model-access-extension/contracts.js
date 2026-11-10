export function modelAccessOrigin(trustSource) {
    if (trustSource === 'dev-session')
        return 'dev';
    if (trustSource === 'user-import')
        return 'user';
    return 'official';
}
//# sourceMappingURL=contracts.js.map