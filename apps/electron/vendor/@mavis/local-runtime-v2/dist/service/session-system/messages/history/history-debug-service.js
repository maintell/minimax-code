/** Diagnostic projection over the current v2 canonical messages.jsonl only. */
export class CanonicalHistoryDebugService {
    options;
    nowMs;
    constructor(options) {
        this.options = options;
        this.nowMs = options.nowMs ?? (() => Date.now());
    }
    async readCurrentHistoryExport(sessionId) {
        const session = await this.options.sessions.get(sessionId);
        if (!session)
            return undefined;
        const messages = await this.options.history.readCurrentHistory(sessionId, session.createdAtMs);
        return { sessionId, exportedAtMs: this.nowMs(), messages };
    }
}
//# sourceMappingURL=history-debug-service.js.map