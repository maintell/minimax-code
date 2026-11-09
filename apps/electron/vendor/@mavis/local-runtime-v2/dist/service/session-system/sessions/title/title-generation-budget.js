/** One title task owns preparation, model retries and backoff under the same deadline. */
export class TitleGenerationBudget {
    deadlineAt;
    signal;
    timeoutController = new AbortController();
    timer;
    constructor(timeoutMs, signals = [], deadlineAt) {
        if (!Number.isFinite(timeoutMs) || (deadlineAt !== undefined && !Number.isFinite(deadlineAt))) {
            throw new RangeError('Title budget must be finite');
        }
        const localDeadline = Date.now() + Math.max(0, timeoutMs);
        this.deadlineAt = Math.min(localDeadline, deadlineAt ?? localDeadline);
        this.signal = AbortSignal.any([...signals, this.timeoutController.signal]);
        this.timer = setTimeout(() => this.expire(), Math.max(0, this.deadlineAt - Date.now()));
        this.timer.unref?.();
    }
    get remainingMs() {
        const remaining = Math.max(0, this.deadlineAt - Date.now());
        if (remaining === 0)
            this.expire();
        return this.signal.aborted ? 0 : remaining;
    }
    assertActive() {
        this.signal.throwIfAborted();
        // Also check wall time after non-cooperative preparation or a late result.
        if (this.remainingMs === 0)
            this.signal.throwIfAborted();
    }
    async waitForRetry(delayMs) {
        if (this.signal.aborted || !Number.isFinite(delayMs) || this.remainingMs === 0)
            return false;
        if (delayMs <= 0)
            return true;
        if (delayMs >= this.remainingMs)
            return false;
        await new Promise((resolve) => {
            const finish = () => {
                clearTimeout(timer);
                this.signal.removeEventListener('abort', finish);
                resolve();
            };
            const timer = setTimeout(finish, delayMs);
            timer.unref?.();
            this.signal.addEventListener('abort', finish, { once: true });
            if (this.signal.aborted)
                finish();
        });
        return this.remainingMs > 0;
    }
    dispose() {
        clearTimeout(this.timer);
    }
    expire() {
        this.timeoutController.abort(new DOMException('Title request timed out', 'TimeoutError'));
    }
}
//# sourceMappingURL=title-generation-budget.js.map