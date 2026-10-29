/**
 * Keeps at most one timing record per session. Every mutation is fenced by
 * both sessionId and turnId so a force-cleared turn cannot erase a successor
 * that already acquired the same session.
 */
export class LocalActiveTurnTimingRegistry {
    nowMs;
    bySession = new Map();
    finishedListeners = new Set();
    constructor(nowMs) {
        this.nowMs = nowMs;
    }
    begin(sessionId, turnId, source) {
        const previous = this.bySession.get(sessionId);
        if (previous?.turnId === turnId)
            return previous;
        const timing = {
            sessionId,
            turnId,
            ...(source ? { source } : {}),
            startedAtMs: this.nowMs(),
            phase: 'running',
        };
        this.bySession.set(sessionId, timing);
        // Force-clear may let a successor begin before the old promise observes
        // its finally. Retire the superseded projection now; the late old finish
        // remains harmless because the map already points at the new turnId.
        if (previous)
            this.notifyFinished(previous);
        return timing;
    }
    markSettling(sessionId, turnId) {
        const current = this.getByTurn(sessionId, turnId);
        if (!current || current.phase === 'settling')
            return;
        // Freeze the end time before outer accounting starts. GET projections can
        // then remain stable throughout async SQLite and session-finalization work.
        this.bySession.set(sessionId, {
            ...current,
            endedAtMs: this.nowMs(),
            phase: 'settling',
        });
    }
    finish(sessionId, turnId) {
        const current = this.getByTurn(sessionId, turnId);
        if (!current)
            return;
        this.bySession.delete(sessionId);
        this.notifyFinished(current);
    }
    notifyFinished(timing) {
        // Cleanup observers are best-effort. Timing ownership must be released
        // even if one domain observer has a bug in its in-memory teardown.
        for (const listener of this.finishedListeners) {
            try {
                listener(timing);
            }
            catch {
                continue;
            }
        }
    }
    getBySession(sessionId) {
        return this.bySession.get(sessionId);
    }
    getByTurn(sessionId, turnId) {
        const timing = this.bySession.get(sessionId);
        return timing?.turnId === turnId ? timing : undefined;
    }
    elapsedSeconds(timing) {
        const endMs = timing.endedAtMs ?? this.nowMs();
        const elapsedMs = Math.max(0, endMs - timing.startedAtMs);
        return elapsedMs === 0 ? 0 : Math.ceil(elapsedMs / 1_000);
    }
    onFinished(listener) {
        this.finishedListeners.add(listener);
        return () => this.finishedListeners.delete(listener);
    }
}
//# sourceMappingURL=turn-timing.js.map