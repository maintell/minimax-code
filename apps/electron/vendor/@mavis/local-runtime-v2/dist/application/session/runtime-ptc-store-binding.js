import { logger as runtimeLogger } from '@mavis/shared/local-runtime-logging';
export function createRuntimePtcStoreBinding(logger) {
    // The runtime's own logger unless the composition passes one. Production host
    // options carry no logger at all, so without this fallback a Fork whose store
    // copy failed would leave no trace anywhere.
    const sink = logger ?? runtimeLogger;
    let store;
    let disabled = false;
    const pending = new Set();
    return {
        bind(bound) {
            // No store in this process: the resets remembered so far can never reach
            // one, so they are dropped rather than kept for a bind that never comes.
            if (bound === undefined) {
                store = undefined;
                disabled = true;
                pending.clear();
                return;
            }
            store = bound;
            for (const sessionId of pending)
                bound.markContextReset(sessionId);
            pending.clear();
        },
        notifyContextReset(sessionId) {
            if (store)
                store.markContextReset(sessionId);
            else if (!disabled)
                pending.add(sessionId);
        },
        forkState: {
            // Fork only runs after the Turn System (and with it the Agent Host) has
            // been initialized, so the store is bound by then.
            //
            // Both halves are best-effort: the store is an optional capability, so a
            // child that starts with nothing stored is a usable conversation while a
            // Fork that fails and rolls itself back is not. A copy that failed
            // halfway has already dropped the child's partial records.
            copySession: async ({ sourceSessionId, targetSessionId, throughAssistantMessageId }) => {
                try {
                    await store?.copySession(sourceSessionId, targetSessionId, throughAssistantMessageId ? { throughAssistantMessageId } : undefined);
                }
                catch (error) {
                    warn(sink, {
                        source_session_id: sourceSessionId,
                        target_session_id: targetSessionId,
                        error: describeError(error),
                    }, 'ptc session store copy failed during fork');
                }
            },
            deleteSession: async (sessionId) => {
                try {
                    await store?.deleteSession(sessionId);
                }
                catch (error) {
                    warn(sink, { session_id: sessionId, error: describeError(error) }, 'ptc session store cleanup failed during fork compensation');
                }
            },
        },
    };
}
function describeError(error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
function warn(logger, fields, message) {
    try {
        logger?.warn?.(fields, message);
    }
    catch {
        // A failing logger cannot report itself; the Fork must not depend on it.
    }
}
//# sourceMappingURL=runtime-ptc-store-binding.js.map