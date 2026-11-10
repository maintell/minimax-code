/**
 * Breaks the Session-system/Pin construction cycle: the Session system is
 * built first and reaches the Pin service only after it is bound. Calls before
 * binding fail closed, so a recovered Pin is never dropped and pinned projects
 * are never mistaken for unpinned ones.
 */
export function createSessionSystemPinBridge() {
    let target;
    const requireTarget = () => {
        if (!target)
            throw new Error('Session system Pin bridge is not bound');
        return target;
    };
    return {
        onImported: async (sessionId) => {
            await requireTarget().addImportedSession(sessionId);
        },
        pinnedProjectIds: async () => (await requireTarget().getOrder()).flatMap((item) => item.ref.type === 'project' && item.project ? [item.project.projectId] : []),
        bind: (next) => {
            if (target)
                throw new Error('Session system Pin bridge is already bound');
            target = next;
        },
    };
}
//# sourceMappingURL=session-system-pin-bridge.js.map