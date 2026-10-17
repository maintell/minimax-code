/**
 * Session-scoped cancellation for Revision work.
 *
 * Cancellation is tracked per session rather than per dispatch, because a
 * session is cancelled while an unknown number of its Revisions are in flight
 * and more are still queued: an abort signal only reaches work that already
 * started, so the session marker is what keeps the next dispatch from running.
 * Resuming clears the marker without touching persisted Revision state, so a
 * cancelled session picks its backlog up exactly where it stopped.
 */
export class WorkspaceIndexingCancellations {
    cancelledSessions = new Set();
    cancel(sessionId) {
        this.cancelledSessions.add(sessionId);
    }
    resume(sessionId) {
        this.cancelledSessions.delete(sessionId);
    }
    isSessionCancelled(sessionId) {
        return this.cancelledSessions.has(sessionId);
    }
    /**
     * Stops the current attempt unless its session is still active. Thrown as an
     * `AbortError` so every layer above treats it as cancellation rather than as
     * a fault worth retrying.
     */
    assertActive(sessionId, signal) {
        if (!signal.aborted && !this.cancelledSessions.has(sessionId))
            return;
        throw Object.assign(new Error('workspace_indexing_cancelled'), {
            name: 'AbortError',
            code: 'workspace_indexing_cancelled',
        });
    }
    /**
     * Whether a raised error should be read as cancellation instead of a fault.
     *
     * The session marker and the signal are consulted alongside the error itself,
     * so a fault raised by an in-flight client call that was aborted a moment
     * later still counts as cancelled and never ages the retry ladder.
     */
    isCancelled(sessionId, signal, error) {
        return (signal.aborted ||
            this.cancelledSessions.has(sessionId) ||
            (error instanceof Error && error.name === 'AbortError'));
    }
}
//# sourceMappingURL=revision-cancellation.js.map