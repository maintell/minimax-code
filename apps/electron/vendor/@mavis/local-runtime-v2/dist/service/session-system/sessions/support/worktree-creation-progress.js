/** Bounds keep every snapshot small enough for the per-connection SSE queue. */
const DEFAULT_THROTTLE_MS = 150;
const MAX_OUTPUT_LINES = 120;
const MAX_OUTPUT_CHARS = 6_000;
const MAX_LINE_CHARS = 400;
/**
 * Git translates a meter's title but not its `<title>: NN% (done/total)` shape,
 * and keeps the `remote:` prefix untranslated, so meters are matched by shape.
 * Fetch reads only local meters (receiving objects, then resolving deltas).
 */
const FETCH_PROGRESS = /^(?!remote:)[^:]+:\s+(\d{1,3})% \(\d+\/\d+\)/u;
const CHECKOUT_PROGRESS = /^[^:]+:\s+(\d{1,3})% \(\d+\/\d+\)/u;
/**
 * Terminal-like view of Git output: `\r` rewrites the current line (Git's
 * progress meter), `\n` commits it. Only a bounded tail is retained.
 */
class GitProgressOutput {
    lines = [];
    current = '';
    carriageReturn = false;
    write(chunk) {
        for (const part of chunk.split(/(\r\n|\r|\n)/u)) {
            if (part === '\n' || part === '\r\n') {
                this.commit();
            }
            else if (part === '\r') {
                this.carriageReturn = true;
            }
            else if (part) {
                if (this.carriageReturn) {
                    this.current = '';
                    this.carriageReturn = false;
                }
                this.current = `${this.current}${part}`.slice(0, MAX_LINE_CHARS);
            }
        }
    }
    appendLine(line) {
        this.finishLine();
        this.current = line.slice(0, MAX_LINE_CHARS);
        this.commit();
    }
    /** Ends a line left open by `\r` so the next writer starts on a new line. */
    finishLine() {
        if (this.current)
            this.commit();
        this.carriageReturn = false;
    }
    latestLine() {
        return this.current || this.lines.at(-1) || '';
    }
    render() {
        return (this.current ? [...this.lines, this.current] : this.lines).join('\n');
    }
    commit() {
        this.lines.push(this.current);
        this.current = '';
        this.carriageReturn = false;
        while (this.lines.length > MAX_OUTPUT_LINES)
            this.lines.shift();
        let chars = this.lines.reduce((total, line) => total + line.length + 1, 0);
        while (chars > MAX_OUTPUT_CHARS && this.lines.length > 1) {
            chars -= (this.lines.shift()?.length ?? 0) + 1;
        }
    }
}
const NOOP_TRACKER = {
    beginFetch: () => undefined,
    fetchOutput: () => undefined,
    endFetch: () => undefined,
    beginCheckout: () => undefined,
    checkoutOutput: () => undefined,
    complete: () => undefined,
    fail: () => undefined,
};
/**
 * Tracks one new-worktree creation and publishes full snapshots. Step changes
 * publish immediately; Git progress lines publish at most once per throttle
 * window, with a trailing snapshot so the latest percentage is never dropped.
 */
export function createWorktreeCreationProgressTracker(options) {
    if (!options.sink)
        return NOOP_TRACKER;
    return new SnapshotTracker(options, options.sink);
}
class SnapshotTracker {
    options;
    sink;
    steps = [
        { kind: 'workspace', status: 'running' },
        { kind: 'checkout', status: 'pending' },
    ];
    output = new GitProgressOutput();
    throttleMs;
    nowMs;
    schedule;
    lastEmitAt = Number.NEGATIVE_INFINITY;
    trailing;
    finished = false;
    constructor(options, sink) {
        this.options = options;
        this.sink = sink;
        this.throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
        this.nowMs = options.nowMs ?? Date.now;
        this.schedule = options.schedule ?? scheduleWithTimer;
        this.output.appendLine('[info] Starting worktree creation');
        this.emitNow();
    }
    beginFetch(target) {
        if (this.finished)
            return;
        this.setStatus('workspace', 'completed');
        if (!this.find('fetch')) {
            this.steps.splice(this.indexOf('checkout'), 0, { kind: 'fetch', status: 'running' });
        }
        this.output.appendLine(`[info] Fetching latest changes from ${target}`);
        this.emitNow();
    }
    fetchOutput(chunk) {
        this.recordOutput(chunk, 'fetch', FETCH_PROGRESS);
    }
    endFetch() {
        if (this.finished)
            return;
        this.setStatus('fetch', 'completed');
        this.output.finishLine();
        this.emitNow();
    }
    beginCheckout() {
        if (this.finished)
            return;
        this.setStatus('workspace', 'completed');
        this.setStatus('checkout', 'running');
        this.emitNow();
    }
    checkoutOutput(chunk) {
        this.recordOutput(chunk, 'checkout', CHECKOUT_PROGRESS);
    }
    complete(worktreeDir) {
        if (this.finished)
            return;
        for (const step of this.steps)
            this.setStatus(step.kind, 'completed');
        this.output.appendLine(`Worktree created at ${worktreeDir}`);
        this.finish();
    }
    fail(message) {
        if (this.finished)
            return;
        const failing = this.steps.find((step) => step.status === 'running') ??
            this.steps.find((step) => step.status === 'pending');
        if (failing)
            this.setStatus(failing.kind, 'failed');
        const summary = message.split(/\r?\n/u).find((line) => line.trim()) ?? message;
        this.output.appendLine(`[error] ${summary.trim()}`);
        this.finish();
    }
    recordOutput(chunk, kind, pattern) {
        if (this.finished || !chunk)
            return;
        this.output.write(chunk);
        const step = this.find(kind);
        if (step?.status === 'running') {
            // One chunk may finish a meter line and start the next one; read every line.
            for (const line of [...chunk.split(/\r\n|\r|\n/u), this.output.latestLine()]) {
                const match = pattern.exec(line);
                const percent = match ? Number(match[1]) : Number.NaN;
                // A step may run several meters in turn (fetch: objects, then deltas);
                // the step's percentage only moves forward.
                if (percent >= 0 && percent <= 100)
                    step.percent = Math.max(step.percent ?? 0, percent);
            }
        }
        this.emitThrottled();
    }
    finish() {
        this.finished = true;
        this.emitNow();
    }
    find(kind) {
        return this.steps.find((step) => step.kind === kind);
    }
    indexOf(kind) {
        return this.steps.findIndex((step) => step.kind === kind);
    }
    setStatus(kind, status) {
        const step = this.find(kind);
        if (!step)
            return;
        step.status = status;
        if (status !== 'running')
            delete step.percent;
    }
    emitThrottled() {
        if (this.trailing)
            return;
        const waitMs = this.lastEmitAt + this.throttleMs - this.nowMs();
        if (waitMs <= 0) {
            this.emitNow();
            return;
        }
        this.trailing = this.schedule(() => {
            this.trailing = undefined;
            if (!this.finished)
                this.emitNow();
        }, waitMs);
    }
    emitNow() {
        this.trailing?.cancel();
        this.trailing = undefined;
        this.lastEmitAt = this.nowMs();
        try {
            this.sink({
                workspace: this.options.workspace,
                branch: this.options.branch,
                steps: this.steps.map((step) => ({ ...step })),
                output: this.output.render(),
            });
        }
        catch {
            // Progress is advisory; worktree creation must not depend on observers.
        }
    }
}
function scheduleWithTimer(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
}
//# sourceMappingURL=worktree-creation-progress.js.map