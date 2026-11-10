/** Only an accepted user stop closes publications; switching views does not. */
export function withPptPreviewTaskStop(existing, preview) {
    if (!preview)
        return existing;
    return {
        begin: (sessionId) => {
            const cascade = existing.begin(sessionId);
            if (!cascade)
                return undefined;
            return {
                accept: async (how) => {
                    await cascade.accept(how);
                    try {
                        await preview.cancelSession(sessionId);
                    }
                    catch {
                        // The authoritative user stop must still succeed if persistence fails.
                    }
                },
                markBoundary: (...args) => cascade.markBoundary(...args),
                complete: (result) => cascade.complete(result),
                cancel: (reason) => cascade.cancel(reason),
            };
        },
    };
}
//# sourceMappingURL=ppt-task-stop-cascade.js.map