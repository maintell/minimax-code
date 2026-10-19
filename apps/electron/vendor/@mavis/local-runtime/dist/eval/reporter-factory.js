import { logger } from '../common/logger.js';
import { buildClioStepsBody, localEvalCaptureLimits, settleWithin, } from './payload.js';
import { LocalEvalReporter } from './reporter.js';
import { LocalEvalRuntimeEventBuffer } from './runtime-event-buffer.js';
import { uploadLocalEvalRequest, readLocalEvalAccessToken, collectLocalEvalMetaInfo, uploadLocalClioSteps, } from './transport.js';
export class LocalEvalReporterFactory {
    options;
    reporters = new Map();
    pending = new Set();
    runtimeReporters = new Map();
    lastStepSequence = 0;
    uploadTailBySession = new Map();
    runtimeEvents;
    fetchImpl;
    nowMs;
    constructor(options) {
        this.options = options;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.nowMs = options.nowMs ?? Date.now;
        this.runtimeEvents = new LocalEvalRuntimeEventBuffer(this.nowMs);
    }
    getReporter(context) {
        const existing = this.reporters.get(context.sessionId);
        if (existing) {
            existing.flushPending();
            existing.refreshSessionFields(context);
            return existing;
        }
        this.runtimeReporters.get(context.sessionId)?.flushPending();
        const reporter = this.createReporter(context);
        this.reporters.set(context.sessionId, reporter);
        return reporter;
    }
    createReporter(context) {
        const limits = localEvalCaptureLimits(this.options);
        return new LocalEvalReporter(this, context, this.nowMs, limits.stepBytes, limits.snapshotBytes, this.options.metricsClient);
    }
    getRuntimeReporter(sessionId) {
        let reporter = this.runtimeReporters.get(sessionId);
        if (reporter)
            return reporter;
        if (this.runtimeReporters.size >= 128)
            this.runtimeReporters.values().next().value?.flushPending();
        reporter = this.createReporter({ sessionId, workspaceDir: '' });
        this.runtimeReporters.set(sessionId, reporter);
        return reporter;
    }
    /**
     * 每次调用都重新求值的开关读取。
     *
     * 宿主传 getter 时会自己 fail-open 到默认值；这里的 try/catch 只是最后一道
     * 防线 —— eval 上报是 best-effort，绝不允许因为读开关失败而把异常抛回业务链路。
     */
    isEnabled() {
        const { enabled } = this.options;
        if (typeof enabled !== 'function')
            return enabled;
        try {
            return enabled() === true;
        }
        catch {
            return false;
        }
    }
    nextStepIndex(timestampMs) {
        const base = timestampMs * 1_000;
        this.lastStepSequence = Math.max(base, this.lastStepSequence + 1);
        return this.lastStepSequence - base;
    }
    releaseRuntimeReporter(sessionId, reporter) {
        if (this.runtimeReporters.get(sessionId) === reporter)
            this.runtimeReporters.delete(sessionId);
    }
    releaseReporter(sessionId) {
        const reporter = this.reporters.get(sessionId);
        reporter?.flushPending();
        this.reporters.delete(sessionId);
        this.runtimeEvents.clear(sessionId);
    }
    canReport() {
        return this.isEnabled() && Boolean(readLocalEvalAccessToken(this.options));
    }
    reportRuntimeEvent(sessionId, input) {
        if (!this.isEnabled())
            return 'skipped_disabled';
        if (!readLocalEvalAccessToken(this.options))
            return 'skipped_no_token';
        const reporter = this.reporters.get(sessionId);
        if (input.origin) {
            (reporter?.hasActiveTurn()
                ? reporter
                : this.getRuntimeReporter(sessionId)).reportRuntimeEvent(input);
            return 'queued';
        }
        if (reporter?.hasFinishedTurn()) {
            // A late background observation has no trustworthy Turn snapshot. Do not buffer it
            // into a later Turn, where it could inherit unrelated SessionRecord fields.
            this.getRuntimeReporter(sessionId).reportRuntimeEvent(input, true);
            return 'queued';
        }
        return this.runtimeEvents.report(sessionId, input, (event) => {
            const current = this.reporters.get(sessionId);
            return current?.hasActiveTurn() ? current.reportRuntimeEvent(event) : false;
        });
    }
    /**
     * Session Clio 开关的每次求值读取，与 `isEnabled()` 同一套 fail-safe 约定：
     * 宿主 getter 自己 fail-open 到默认值，这里的 try/catch 只兜底 getter 抛错，
     * 绝不让读开关失败把异常抛回采集/上传链路。
     */
    isClioEnabled() {
        const enabled = this.options.clio?.enabled;
        if (typeof enabled !== 'function')
            return enabled === true;
        try {
            return enabled() === true;
        }
        catch {
            return false;
        }
    }
    /**
     * Whether Session Clio capture is switched on at all.
     *
     * Deliberately independent of both raw Eval capture and the access token:
     * capture records durably to disk and uploads later, so a momentarily missing
     * token must not silently drop a user's Query.
     */
    isClioCaptureEnabled() {
        return this.isClioEnabled();
    }
    /**
     * Whether an upload may run right now: capture on, the desktop owner's
     * receiving capabilities ready, and a usable access token present.
     */
    canReportClio() {
        const clio = this.options.clio;
        if (!clio || !this.isClioEnabled())
            return false;
        try {
            if (clio.isReady && !clio.isReady())
                return false;
        }
        catch {
            return false;
        }
        return Boolean(readLocalEvalAccessToken(this.options));
    }
    async reportClioSteps(input) {
        const clio = this.options.clio;
        if (!clio || !this.isClioEnabled())
            return { status: 'skipped', reason: 'disabled' };
        try {
            if (clio.isReady && !clio.isReady())
                return { status: 'skipped', reason: 'not-ready' };
        }
        catch {
            return { status: 'skipped', reason: 'not-ready' };
        }
        const accessToken = readLocalEvalAccessToken(this.options);
        if (!accessToken)
            return { status: 'skipped', reason: 'no-token' };
        if (input.steps.length === 0)
            return { status: 'reported' };
        return uploadLocalClioSteps({
            body: buildClioStepsBody({
                trajectoryId: input.trajectoryId,
                captureOrigin: input.captureOrigin,
                steps: input.steps,
            }),
            sessionId: input.sessionId,
            options: this.options,
            fetchImpl: this.fetchImpl,
            accessToken,
        });
    }
    drainRuntimeEvents(sessionId, reporter) {
        reporter.reportBufferedRuntimeEvents(this.runtimeEvents.drain(sessionId));
    }
    enqueue(request, sessionId) {
        if (!this.isEnabled())
            return;
        if (!readLocalEvalAccessToken(this.options))
            return;
        const previous = this.uploadTailBySession.get(sessionId) ?? Promise.resolve();
        const upload = previous.then(() => this.upload(request, sessionId));
        this.uploadTailBySession.set(sessionId, upload);
        this.pending.add(upload);
        void upload.finally(() => {
            this.pending.delete(upload);
            if (this.uploadTailBySession.get(sessionId) === upload) {
                this.uploadTailBySession.delete(sessionId);
            }
        });
    }
    enqueueMetaInfo(reporter, workspaceDir, sessionMetadata) {
        const report = collectLocalEvalMetaInfo(this.options, workspaceDir).then((value) => {
            if (!value)
                return;
            reporter.reportMetaInfo(value, sessionMetadata);
            reporter.flushPending();
        });
        this.pending.add(report);
        void report.then(() => {
            this.pending.delete(report);
        }, () => {
            this.pending.delete(report);
        });
    }
    async flush(timeoutMs) {
        const boundedTimeoutMs = timeoutMs === undefined
            ? undefined
            : Number.isFinite(timeoutMs)
                ? Math.max(0, Math.floor(timeoutMs))
                : 0;
        const deadline = boundedTimeoutMs === undefined ? undefined : Date.now() + boundedTimeoutMs;
        for (const reporter of [...this.reporters.values(), ...this.runtimeReporters.values()])
            reporter.flushPending();
        while (this.pending.size > 0) {
            const pending = [...this.pending];
            if (deadline === undefined) {
                await Promise.all(pending);
            }
            else {
                const remainingMs = deadline - Date.now();
                if (remainingMs <= 0 || !(await settleWithin(pending, remainingMs))) {
                    logger.warn({ pendingCount: this.pending.size, timeoutMs: boundedTimeoutMs }, '[eval-capture] local eval flush deadline exceeded');
                    return;
                }
            }
            for (const reporter of [...this.reporters.values(), ...this.runtimeReporters.values()])
                reporter.flushPending();
        }
    }
    async upload(request, sessionId) {
        // 同一 session 的上传在 uploadTailBySession 上串行排队，队尾项可能已经等了很久。
        // enqueue() 的检查只代表入队那一刻，用户在等待期间关掉开关后这些还没发出的队列项
        // 必须丢弃 —— 否则「关掉开关」对一个上传较慢的 session 不会立刻生效。
        if (!this.isEnabled())
            return;
        const accessToken = readLocalEvalAccessToken(this.options);
        if (!accessToken)
            return;
        await uploadLocalEvalRequest({
            request,
            sessionId,
            options: this.options,
            fetchImpl: this.fetchImpl,
            accessToken,
        });
    }
}
//# sourceMappingURL=reporter-factory.js.map