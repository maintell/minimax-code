export function isVisibleTreeSession(session) {
    if (session.visibility === 'hidden')
        return false;
    const purpose = session.purpose ?? '';
    return !purpose.startsWith('peek_') && !purpose.startsWith('peek:');
}
//# sourceMappingURL=visibility.js.map