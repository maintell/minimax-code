import { isDesktopToolErrorCode } from '@mavis/agent-tools';
import { incrementMetric, observeMetric, } from '@mavis/shared/local-runtime-logging/metric-registry';
import { randomUUID } from 'node:crypto';
/**
 * The Runtime side of the "ask the desktop UI to do it" channel.
 *
 * A few Agent tools drive capabilities that live in the renderer or the
 * Electron main process. The broker publishes one `ui.request` global event
 * per call, keeps the request pending until the UI replies over HTTP, and
 * settles it with `UI_UNAVAILABLE` when nothing answers in time — the same
 * event-then-HTTP-reply shape `ask_user` already uses, so no new transport is
 * introduced.
 *
 * Only the first reply settles a request: a second window, or a UI that
 * retries, cannot overwrite the answer the tool already returned. The global
 * event stream is live and never replayed, so a request raised while no
 * window is open simply times out; every one of these operations is
 * idempotent, so the model retrying is harmless.
 */
/** Interactive operations; the UI answers these within a few hundred ms. */
const DEFAULT_TIMEOUT_MS = 10_000;
/** Operations that leave the renderer to reach a remote service. */
const SLOW_OPERATION_TIMEOUT_MS = 30_000;
const SLOW_OPERATIONS = new Set([
    'usage.get',
    'app.update_check',
]);
/** @internal Exported only for focused tests. */
export function defaultUiRequestTimeoutMs(operation) {
    return SLOW_OPERATIONS.has(operation) ? SLOW_OPERATION_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}
/**
 * The `operation` metric label: registry label values are snake_case, so a
 * dotted operation is reported with its dot written as an underscore.
 */
const OPERATION_METRIC_LABELS = {
    'session.open': 'session_open',
    'session.mark_read': 'session_mark_read',
    'sidebar.preferences.update': 'sidebar_preferences_update',
    'usage.get': 'usage_get',
    'app.update_check': 'app_update_check',
    'panel.open_file': 'panel_open_file',
    'panel.open_review': 'panel_open_review',
};
/** The bounded `status` label the request metrics count by. */
function outcomeStatus(outcome) {
    if (outcome.ok)
        return 'ok';
    return outcome.code === 'UI_UNAVAILABLE' ? 'timeout' : 'failed';
}
/** Settled ids kept only so a late second reply is not reported as unknown. */
const SETTLED_REQUEST_MEMORY = 200;
export function createUiRequestBroker(options) {
    const pending = new Map();
    const settled = new Set();
    // The host attaches its MetricsClient after the Runtime composed the broker.
    let metrics = options.metrics;
    const nowMs = options.nowMs ?? Date.now;
    const newRequestId = options.newRequestId ?? (() => `ui_${randomUUID()}`);
    const timeoutMsFor = options.timeoutMsFor ?? defaultUiRequestTimeoutMs;
    function finish(requestId, outcome) {
        const entry = pending.get(requestId);
        if (!entry || entry.settled)
            return;
        entry.settled = true;
        clearTimeout(entry.timer);
        entry.detachAbort();
        pending.delete(requestId);
        settled.add(requestId);
        if (settled.size > SETTLED_REQUEST_MEMORY) {
            const oldest = settled.values().next().value;
            if (typeof oldest === 'string')
                settled.delete(oldest);
        }
        entry.settle(outcome);
        const status = outcomeStatus(outcome);
        incrementMetric(metrics, 'ui_request_total', 1, {
            operation: OPERATION_METRIC_LABELS[entry.operation],
            status,
        });
        observeMetric(metrics, 'ui_request_duration_ms', nowMs() - entry.startedAt, {
            operation: OPERATION_METRIC_LABELS[entry.operation],
        });
        if (!outcome.ok) {
            options.logger?.error({ operation: entry.operation, status, error_code: outcome.code }, '[local-runtime-v2] ui request did not complete');
        }
    }
    return {
        attachMetrics(next) {
            metrics = next;
        },
        request(input, signal) {
            const requestId = newRequestId();
            const timeoutMs = timeoutMsFor(input.operation);
            return new Promise((resolve) => {
                const onAbort = () => {
                    finish(requestId, {
                        ok: false,
                        code: 'UI_UNAVAILABLE',
                        message: `The turn ended before the desktop window answered ${input.operation}.`,
                    });
                };
                const entry = {
                    operation: input.operation,
                    startedAt: nowMs(),
                    settle: resolve,
                    settled: false,
                    timer: setTimeout(() => {
                        finish(requestId, {
                            ok: false,
                            code: 'UI_UNAVAILABLE',
                            message: `The desktop window did not answer ${input.operation} within ${timeoutMs}ms.`,
                        });
                    }, timeoutMs),
                    detachAbort: () => signal?.removeEventListener('abort', onAbort),
                };
                pending.set(requestId, entry);
                if (signal?.aborted === true) {
                    onAbort();
                    return;
                }
                signal?.addEventListener('abort', onAbort, { once: true });
                // Spreading the input keeps `operation` and `target` correlated, which
                // rebuilding them field by field would not.
                const { sessionId, ...target } = input;
                options.publishGlobalEvent({
                    type: 'ui.request',
                    payload: { requestId, sessionId, ...target },
                });
            });
        },
        reply(requestId, reply) {
            // A second window, or a retrying UI, must learn its reply was ignored
            // rather than that the request never existed.
            if (settled.has(requestId))
                return 'already-settled';
            const entry = pending.get(requestId);
            if (!entry)
                return 'unknown';
            if (entry.settled)
                return 'already-settled';
            finish(requestId, toOutcome(reply));
            return 'accepted';
        },
        pendingCount() {
            return pending.size;
        },
    };
}
/**
 * A UI-reported failure keeps its own code as long as it is one of the shared
 * desktop codes, so the tool can tell a bad argument (retrying will not help)
 * from the window failing to run the request. Anything else is narrowed, which
 * is what keeps the `managed_tool_error_total` label bounded.
 */
function toOutcome(reply) {
    if (reply.ok)
        return { ok: true, data: reply.data ?? {} };
    return {
        ok: false,
        code: isDesktopToolErrorCode(reply.code) ? reply.code : 'UI_REQUEST_FAILED',
        message: reply.message ?? 'The desktop window could not run the request.',
    };
}
//# sourceMappingURL=ui-request-broker.js.map