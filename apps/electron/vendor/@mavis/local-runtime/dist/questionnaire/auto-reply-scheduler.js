const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
/**
 * Host-owned scheduler for Goal questionnaires.
 *
 * The persisted absolute deadline is authoritative. The renderer may display
 * a countdown, but only this runtime-owned scheduler mutates questionnaire
 * state. Versioned timers ensure a concurrent manual reply/dismiss wins by
 * cancelling any pending retry after the store CAS settles.
 */
export class QuestionnaireAutoReplyScheduler {
    options;
    scheduled = new Map();
    requestSessions = new Map();
    versions = new Map();
    inFlight = new Set();
    retryDelayMs;
    closed = false;
    constructor(options) {
        this.options = options;
        this.retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    }
    schedule(record) {
        if (this.closed ||
            record.status !== 'pending' ||
            record.request.purpose !== 'goal' ||
            !Number.isFinite(record.request.expiresAt)) {
            return;
        }
        const expiresAt = record.request.expiresAt;
        if (expiresAt === undefined)
            return;
        this.replace(record.requestId, record.sessionId, Math.max(0, expiresAt - this.options.nowMs()));
    }
    scheduleRetry(requestId, sessionId) {
        if (this.closed)
            return;
        this.replace(requestId, sessionId, this.retryDelayMs);
    }
    cancel(requestId) {
        this.bumpVersion(requestId);
        this.clearTimer(requestId);
        this.requestSessions.delete(requestId);
    }
    cancelSession(sessionId) {
        for (const [requestId, ownerSessionId] of this.requestSessions) {
            if (ownerSessionId === sessionId)
                this.cancel(requestId);
        }
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        for (const requestId of [...this.requestSessions.keys()])
            this.cancel(requestId);
    }
    replace(requestId, sessionId, delayMs) {
        this.clearTimer(requestId);
        const version = this.bumpVersion(requestId);
        this.requestSessions.set(requestId, sessionId);
        this.arm(requestId, sessionId, version, delayMs);
    }
    arm(requestId, sessionId, version, delayMs) {
        const timer = setTimeout(() => void this.fire(requestId, sessionId, version), Math.min(MAX_TIMER_DELAY_MS, Math.max(0, delayMs)));
        timer.unref?.();
        this.scheduled.set(requestId, { sessionId, timer, version });
    }
    async fire(requestId, sessionId, version) {
        if (this.closed || this.versions.get(requestId) !== version || this.inFlight.has(requestId)) {
            return;
        }
        this.clearTimer(requestId);
        this.inFlight.add(requestId);
        let result = 'done';
        try {
            result = await this.options.run(requestId);
        }
        catch {
            result = 'retry';
        }
        finally {
            this.inFlight.delete(requestId);
        }
        if (this.closed || this.versions.get(requestId) !== version)
            return;
        if (result === 'retry') {
            this.arm(requestId, sessionId, version, this.retryDelayMs);
            return;
        }
        this.requestSessions.delete(requestId);
    }
    clearTimer(requestId) {
        const entry = this.scheduled.get(requestId);
        if (!entry)
            return;
        clearTimeout(entry.timer);
        this.scheduled.delete(requestId);
    }
    bumpVersion(requestId) {
        const version = (this.versions.get(requestId) ?? 0) + 1;
        this.versions.set(requestId, version);
        return version;
    }
}
//# sourceMappingURL=auto-reply-scheduler.js.map