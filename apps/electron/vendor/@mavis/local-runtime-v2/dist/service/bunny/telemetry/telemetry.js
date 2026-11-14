import { BUNNY_TRACE_EVENTS, METRIC_DEFINITIONS, } from '@mavis/shared/local-runtime-logging/metric-registry';
import { incrementMetric, observeMetric, } from '@mavis/shared/local-runtime-logging/metrics';
import { logger as runtimeLogger } from '../../../infra/logging/logger.js';
import { countAssignment } from './assignment-metrics.js';
import { failureCode, failureDetail, failureMetricCode } from './sanitize.js';
import { BunnyStateTrace } from './state-trace.js';
/** Trace event labels the registry lists; any other event is `other`. */
const TRACE_EVENTS = new Set(BUNNY_TRACE_EVENTS);
/** Wake reasons in the order the primary one is picked: what the user did comes first. */
const WAKE_PRIORITY = [
    'user',
    'user_answer',
    'task_report',
    'cron',
    'self_reminder',
    'background_task',
    'peer',
];
/** Compaction outcomes that end an attempt; `skipped` counts only when the failure limit is hit. */
const TERMINAL_COMPACTIONS = new Set([
    'committed',
    'failed',
    'voided',
    'merged',
    'delegated',
]);
/**
 * Bunny's telemetry (decision 5). Bunny's modules call its named methods; it decides what goes
 * to the trace (Developer Tools and Session Clio), the metrics and the local log. It reports
 * only at boundaries — a Turn's end, a compaction's result, a write, a failure — never from a
 * streaming loop, and nothing it does can fail the caller.
 */
export class BunnyTelemetry {
    options;
    stateTrace;
    logger;
    /** The current segment of each main conversation, from its compaction trace. */
    segments = new Map();
    constructor(options) {
        this.options = options;
        this.logger = options.logger ?? runtimeLogger;
        // The state trace measures its own events, payload building included.
        this.stateTrace = new BunnyStateTrace(options.trace, {
            measured: (eventType, ms) => this.traceOverhead(eventType, ms),
            ...(options.taskIdOf ? { taskIdOf: options.taskIdOf } : {}),
        });
    }
    /**
     * The trace port segment compaction reports to: the trace as before, plus the current
     * segment of each conversation and the metrics of each compaction that ended.
     */
    segmentTrace() {
        const sink = this.traceSink();
        return {
            reportRuntimeEvent: (sessionId, event) => {
                sink.reportRuntimeEvent(sessionId, event);
                this.guard(() => this.segmentEvent(sessionId, event.eventType, event.payload));
                return undefined;
            },
        };
    }
    /** Whether a Bunny Turn's state injection still waits for its main request to go out. */
    awaitsRequest(turn) {
        try {
            return this.stateTrace.awaitsRequest(turn);
        }
        catch {
            return false;
        }
    }
    /** A Bunny Turn's main model request went out; its state injection is traced after it. */
    requestSent(turn) {
        this.guard(() => this.stateTrace.requestSent(turn));
    }
    /**
     * The round budget's summary of a Turn: the log line and trajectory event it always wrote,
     * now also in Developer Tools.
     */
    roundBudget(summary, payload) {
        this.guard(() => {
            this.logger.info?.({ event: 'bunny_round_budget_turn_summary', ...payload }, '[bunny-round-budget] turn summary');
        });
        this.traceSink().reportRuntimeEvent(summary.sessionId, {
            eventType: 'bunny_round_budget_turn_summary',
            payload,
            origin: { turnId: summary.turnId },
        });
    }
    /**
     * One of Bunny's sends was admitted, or one of its stops took effect (`bunny_assignment_total`).
     * Creates and cancels are counted from task history.
     */
    assignmentCalled(action, reason) {
        countAssignment(this.options.metrics, action, reason);
    }
    /** A Bunny Turn ended: its trace and metrics. */
    turnEnded(facts) {
        this.guard(() => {
            const segmentId = this.segments.get(facts.sessionId);
            const summary = this.stateTrace.ended({ ...facts, ...(segmentId ? { segmentId } : {}) });
            // Only Bunny's main conversation is traced; its other Sessions have no Turn summary.
            if (!summary)
                return;
            // Its first visible text is pi_turn_first_visible_text_ms{agentKind="bunny_main"}; the
            // trace keeps its own first_visible_text_ms.
            incrementMetric(this.options.metrics, 'bunny_turn_total', 1, {
                primary_wake: primaryWakeReason(summary.wakeReasons),
                silent: facts.silent ? 'true' : 'false',
                model: modelLabel(facts.model),
            });
        });
    }
    /**
     * A Bunny module failed: one warn line with the raw code and the detail (paths removed), and a
     * count by scope and the code from the registry's closed list.
     */
    failure(input) {
        this.guard(() => {
            this.logFailure(input, failureCode(input.error));
            incrementMetric(this.options.metrics, 'bunny_failure_total', 1, {
                scope: input.scope,
                code: failureMetricCode(input.error),
            });
        });
    }
    /**
     * A write to Bunny's memory finished: remember's add, update and forget, the user's edit in
     * settings, or a background capture or lint run.
     */
    memoryWritten(input) {
        incrementMetric(this.options.metrics, 'bunny_memory_write_total', 1, {
            op: input.op,
            outcome: input.outcome,
        });
    }
    /**
     * One conversation search or read finished, called directly or from `run_code`: its latency
     * (spec 18.1's budget), and a call counted for the Turn it ran in.
     */
    searched(tool, ms, turn) {
        observeMetric(this.options.metrics, 'bunny_conversation_tool_ms', ms, { tool });
        if (turn)
            this.guard(() => this.stateTrace.toolFinished(turn.sessionId, turn.turnId, tool));
    }
    segmentEvent(sessionId, eventType, payload) {
        if (!isRecord(payload))
            return;
        const segmentId = stringOf(payload['segment_id']);
        if (eventType === 'bunny.segment' && segmentId)
            this.segments.set(sessionId, segmentId);
        if (eventType === 'bunny.compaction' && isFinishedCompaction(payload))
            this.compactionFinished(payload);
    }
    compactionFinished(payload) {
        const labels = METRIC_DEFINITIONS.bunny_compaction_total.labels;
        const trigger = registeredValue(labels.trigger, payload['trigger']);
        const outcome = registeredValue(labels.outcome, payload['outcome']);
        // Segment compaction reports registered triggers and outcomes only; nothing else is counted.
        if (!trigger || !outcome)
            return;
        const metrics = this.options.metrics;
        incrementMetric(metrics, 'bunny_compaction_total', 1, { trigger, outcome });
        const durationMs = numberOf(payload['duration_ms']);
        if (durationMs !== undefined)
            observeMetric(metrics, 'bunny_compaction_run_ms', durationMs, { outcome });
        // The saved share is 1 - after / before over the two sums.
        const before = numberOf(payload['tokens_before']);
        const after = numberOf(payload['tokens_after']);
        if (outcome === 'committed' && before && after !== undefined) {
            incrementMetric(metrics, 'bunny_compaction_before_tokens_total', before, {});
            incrementMetric(metrics, 'bunny_compaction_after_tokens_total', after, {});
        }
    }
    /** The failure's one warn line; a log that fails still lets it be counted and reported. */
    logFailure(input, code) {
        this.guard(() => this.logger.warn?.({
            scope: input.scope,
            code,
            ...(input.sessionId ? { session_id: input.sessionId } : {}),
            ...(input.turnId ? { turn_id: input.turnId } : {}),
            ...(input.taskId ? { task_id: input.taskId } : {}),
            detail: failureDetail(input.error),
        }, 'bunny.failure'));
    }
    /** The trace sink, measured; it never fails the caller. */
    traceSink() {
        const trace = this.options.trace;
        return {
            reportRuntimeEvent: (sessionId, event) => {
                if (!trace)
                    return undefined;
                const startedAt = performance.now();
                try {
                    return trace.reportRuntimeEvent(sessionId, event);
                }
                catch {
                    return undefined;
                }
                finally {
                    this.traceOverhead(event.eventType, performance.now() - startedAt);
                }
            },
        };
    }
    /** Building and reporting one trace event: what the trace costs Bunny's Turns. */
    traceOverhead(eventType, ms) {
        observeMetric(this.options.metrics, 'bunny_trace_overhead_ms', ms, {
            event: traceEventLabel(eventType),
        });
    }
    guard(run) {
        try {
            run();
        }
        catch {
            // Telemetry never changes what Bunny does.
        }
    }
}
/** A compaction that ended; a skip counts only when the failure limit stopped it. */
function isFinishedCompaction(payload) {
    const outcome = String(payload['outcome']);
    return (TERMINAL_COMPACTIONS.has(outcome) ||
        (outcome === 'skipped' && payload['reason'] === 'failure_limit'));
}
/** Longer model IDs are cut: a label stays short whatever a custom provider names its model. */
const MAX_MODEL_LABEL_LENGTH = 64;
/** A Turn's model as a metric label: its model ID, `unknown` when the Turn resolved none. */
function modelLabel(model) {
    const id = model?.trim();
    return id ? id.slice(0, MAX_MODEL_LABEL_LENGTH) : 'unknown';
}
function primaryWakeReason(reasons) {
    return WAKE_PRIORITY.find((reason) => reasons.includes(reason)) ?? 'none';
}
/** A trace event's `event` label: its name without the `bunny.` or `bunny_` prefix, else other. */
function traceEventLabel(eventType) {
    const name = eventType.replace(/^bunny[._]/, '');
    return TRACE_EVENTS.has(name) ? name : 'other';
}
/** `value` when the registry lists it for the label, else undefined. */
function registeredValue(values, value) {
    return values.find((candidate) => candidate === value);
}
function numberOf(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function stringOf(value) {
    return typeof value === 'string' ? value : undefined;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=telemetry.js.map