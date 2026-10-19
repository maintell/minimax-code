/**
 * NudgeRegistry — shared state for BoardWatcher nudge → system-reminder injection.
 *
 * BoardWatcher writes pending nudges here when a worker is silent;
 * a system-reminder provider reads them and injects an <engine-nudge>
 * block into the worker's next tool-result turn.
 *
 * Lifecycle:
 *   1. BoardWatcher.poll() detects silence → nudgeRegistry.set(sessionId, ...)
 *   2. Next tool-result for that session → system-reminder provider reads + clears
 *   3. Agent sees the nudge and (hopefully) updates the board
 *   4. If still silent at next poll → BoardWatcher sets another nudge
 *
 * The registry is process-level in-memory state — no persistence needed.
 */
export class NudgeRegistry {
    pending = new Map();
    /** Set a pending nudge for a session. Overwrites any previous nudge. */
    set(sessionId, info) {
        this.pending.set(sessionId, info);
    }
    /** Get the pending nudge for a session (undefined if none). */
    get(sessionId) {
        return this.pending.get(sessionId);
    }
    /** Clear the nudge for a session (called after injection or board update). */
    clear(sessionId) {
        this.pending.delete(sessionId);
    }
    /** Clear all entries (used on watcher stop). */
    clearAll() {
        this.pending.clear();
    }
    /** Number of pending nudges (for testing). */
    get size() {
        return this.pending.size;
    }
}
//# sourceMappingURL=nudge-registry.js.map