/** Instance-local binding only. Missing or released owners always fail closed. */
export function createDeferredPluginHookPermissionCapability() {
    let current;
    const requireOwner = () => {
        if (!current)
            throw new Error('Plugin Hook permission owner is not initialized or has been closed.');
        return current;
    };
    return {
        capability: {
            effective: async (input) => requireOwner().effective(input),
            applyAtomic: async (input) => requireOwner().applyAtomic(input),
            clearSession: async (sessionId) => requireOwner().clearSession(sessionId),
        },
        bind: (owner) => {
            if (current)
                throw new Error('Plugin Hook permission owner is already bound.');
            current = owner;
            return () => {
                if (current === owner)
                    current = undefined;
            };
        },
    };
}
//# sourceMappingURL=plugin-hook-permission-port.js.map