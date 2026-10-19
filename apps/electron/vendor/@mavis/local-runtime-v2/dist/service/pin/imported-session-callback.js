/** Breaks the Session-import/Pin construction cycle without ever dropping a recovered Pin. */
export function createImportedSessionPinCallback() {
    let target;
    return {
        onImported: async (sessionId) => {
            if (!target)
                throw new Error('Imported Session Pin callback is not bound');
            await target.addImportedSession(sessionId);
        },
        bind: (next) => {
            if (target)
                throw new Error('Imported Session Pin callback is already bound');
            target = next;
        },
    };
}
//# sourceMappingURL=imported-session-callback.js.map