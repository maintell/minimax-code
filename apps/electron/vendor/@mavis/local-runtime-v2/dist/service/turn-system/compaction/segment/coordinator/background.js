import { randomUUID } from 'node:crypto';
import { failureReason, generatedFields, generateRebuild, isTimeout } from '../rebuild-pipeline.js';
import { traceSegmentCompaction } from '../trace.js';
import { scheduleIdleTrace } from '../idle-trace.js';
/**
 * 10.3: idle is traced at 90% of the route's prompt-cache lifetime. The only
 * known lifetime is the Messages protocol's 5 minutes; a route whose lifetime
 * is unknown uses the same 5-minute base, so the threshold is 270 s.
 */
const IDLE_TRACE_MS = 270_000;
/**
 * Background segment rebuilds (11.1, 11.3, 11.9, 11.10): started when a Turn ends over the soft
 * line or a request crosses the hard line, kept as a ready result for the next commit point,
 * voided when the history moves, held back after failures.
 */
export class SegmentBackgroundCompaction {
    core;
    constructor(core) {
        this.core = core;
    }
    async afterTurnSafely(input) {
        try {
            await this.afterTurn(input);
        }
        catch {
            // Background compaction never fails a committed Turn.
        }
    }
    async afterTurn(input) {
        if (!this.core.profileEnabled(input.sessionId))
            return;
        const state = this.core.state(input.sessionId);
        // The first Turn on a new coordinator model recomputes its lines (2.6).
        const switched = state.lastRoute !== undefined && state.lastRoute.model.id !== input.route.model.id;
        state.lastRoute = input.route;
        state.lastTurnEndedAtMs = this.core.now();
        state.turnsInSegment += 1;
        const current = await this.core.ports.history.readSegment(input.sessionId);
        this.core.refreshSegment(state, current.segmentId);
        const messages = current.records.map((record) => record.message);
        const snapshot = this.core.prefixes.get(input.sessionId);
        const tokens = this.core.measure(input.route.model, messages, snapshot);
        const budget = this.core.budget(input.route, snapshot);
        scheduleIdleTrace(this.core.ports.trace, input.sessionId, state, {
            growth: this.core.segmentGrowth(input.route.model, state, messages),
            thresholdMs: this.core.options.idleTraceMs ?? IDLE_TRACE_MS,
        });
        const trigger = this.backgroundTrigger(tokens > budget.softLine, switched, messages);
        if (trigger) {
            this.startBackground(input.sessionId, {
                turnId: input.turnId,
                trigger,
                route: input.route,
            });
        }
    }
    /** 11.1: the soft line, or old tool results over the watermark, start a background compaction. */
    backgroundTrigger(overSoftLine, switched, messages) {
        if (overSoftLine)
            return switched ? 'model_switch' : 'soft_line';
        return this.core.options.exceedsToolResultWatermark?.(messages)
            ? 'tool_result_watermark'
            : undefined;
    }
    /**
     * Starts one background compaction over the current active history (11.1,
     * 11.3). It belongs to the Session, not to a Turn: stopping a Turn never
     * stops it, only `discardPending` does.
     */
    startBackground(sessionId, start) {
        const state = this.core.state(sessionId);
        if (state.inFlight || state.ready || state.replacePending)
            return;
        // A Turn-start commit sizes the result for this route until a Turn end hands one over.
        state.lastRoute ??= start.route;
        const controller = new AbortController();
        const generation = ++state.generation;
        const promise = this.runBackgroundSafely({ ...start, sessionId, signal: controller.signal, generation }, state, controller);
        state.inFlight = { promise, controller, trigger: start.trigger };
    }
    async runBackgroundSafely(job, state, controller) {
        try {
            await this.runBackground(job);
        }
        catch {
            // Failures are traced inside; nothing reaches the Turn.
        }
        finally {
            if (state.inFlight?.controller === controller)
                state.inFlight = undefined;
        }
    }
    async runBackground(job) {
        const { sessionId, turnId, trigger, route, signal, generation } = job;
        const state = this.core.state(sessionId);
        const current = await this.core.ports.history.readSegment(sessionId);
        this.core.refreshSegment(state, current.segmentId);
        if (!job.force && this.core.retryWaiting(state)) {
            traceSegmentCompaction(this.core.ports.trace, sessionId, turnId, {
                trigger,
                outcome: 'skipped',
                reason: 'retry_wait',
                background: true,
                segmentId: current.segmentId,
                failureCount: state.failures,
            });
            return;
        }
        const coveredCount = this.jobCoverage(job, current);
        if (coveredCount === 0)
            return;
        traceSegmentCompaction(this.core.ports.trace, sessionId, turnId, {
            trigger,
            outcome: 'started',
            background: true,
            segmentId: current.segmentId,
            coveredCount,
        });
        const startedAtMs = this.core.now();
        try {
            const generated = await generateRebuild({
                ports: this.core.ports,
                sessionId,
                compactionId: `bunny_${randomUUID()}`,
                trigger,
                segmentId: current.segmentId,
                records: current.records,
                coveredCount,
                ...this.core.rebuildOptions(sessionId, route, this.core.prefixes.get(sessionId)),
                signal,
                ...(this.core.options.timeoutMs === undefined
                    ? {}
                    : { timeoutMs: this.core.options.timeoutMs }),
            });
            if (state.generation !== generation)
                return;
            state.ready = generated;
            traceSegmentCompaction(this.core.ports.trace, sessionId, turnId, {
                ...generatedFields(generated),
                outcome: 'ready',
                background: true,
            });
        }
        catch (error) {
            if (state.generation !== generation || (signal.aborted && !isTimeout(error)))
                return;
            this.core.recordFailure(state);
            traceSegmentCompaction(this.core.ports.trace, sessionId, turnId, {
                trigger,
                outcome: 'failed',
                reason: failureReason(error),
                background: true,
                segmentId: current.segmentId,
                coveredCount,
                durationMs: Math.max(0, this.core.now() - startedAtMs),
                failureCount: state.failures,
            });
        }
    }
    jobCoverage(job, current) {
        return job.coverBefore === undefined
            ? current.records.length
            : this.core.turnTailStart(job.sessionId, current, job.coverBefore);
    }
    /**
     * A result that failed its commit checks (11.6, 11.10): dropped like any
     * pending result, and counted as a failure, so the next background attempt
     * waits.
     */
    rejectPending(sessionId, reason, turnId) {
        this.core.recordFailure(this.core.state(sessionId));
        this.discardPending(sessionId, reason, turnId);
    }
    /** Drops in-flight and ready results; a written ledger delta stays (11.7). */
    discardPending(sessionId, reason, turnId) {
        const state = this.core.sessions.get(sessionId);
        if (!state)
            return;
        const pending = state.ready ?? state.replacePending?.generated;
        const running = state.inFlight;
        state.generation += 1;
        running?.controller.abort(new Error(reason));
        state.inFlight = undefined;
        state.ready = undefined;
        state.replacePending = undefined;
        if (pending) {
            traceSegmentCompaction(this.core.ports.trace, sessionId, turnId, {
                ...generatedFields(pending),
                outcome: 'voided',
                reason,
                background: true,
            });
        }
        else if (running) {
            traceSegmentCompaction(this.core.ports.trace, sessionId, turnId, {
                trigger: running.trigger,
                outcome: 'voided',
                reason,
                background: true,
            });
        }
    }
}
//# sourceMappingURL=background.js.map