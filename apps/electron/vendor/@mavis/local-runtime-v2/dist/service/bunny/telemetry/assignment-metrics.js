import { isBunnyAgentName } from '@mavis/shared/agent-avatar';
import { METRIC_DEFINITIONS } from '@mavis/shared/local-runtime-logging/metric-registry';
import { incrementMetric, } from '@mavis/shared/local-runtime-logging/metrics';
// Label values come from the registry: a value it adds is counted here without a second list.
const ASSIGNMENT_LABELS = METRIC_DEFINITIONS.bunny_assignment_total.labels;
const TASK_CREATED_LABELS = METRIC_DEFINITIONS.bunny_task_created_total.labels;
const TASK_CLOSE_STATES = METRIC_DEFINITIONS.bunny_task_closed_total.labels.state;
/**
 * The labels of one counted call; only a send carries a reason.
 * @internal Exported only for focused tests.
 */
export function assignmentMetricLabels(action, reason) {
    return {
        action,
        reason: action === 'send' ? (known(ASSIGNMENT_LABELS.reason, reason) ?? 'none') : 'none',
    };
}
/**
 * The labels of one created task: each dispatch fact, `unknown` when the history lacks it or
 * records a value the registry does not list.
 * @internal Exported only for focused tests.
 */
export function taskCreatedLabels(dispatch) {
    return {
        exec_location: known(TASK_CREATED_LABELS.exec_location, dispatch.execLocation) ?? 'unknown',
        trigger: known(TASK_CREATED_LABELS.trigger, dispatch.trigger) ?? 'unknown',
    };
}
function known(values, value) {
    return values.find((candidate) => candidate === value);
}
/** Counts one succeeded call; counting never fails the call. */
export function countAssignment(metrics, action, reason) {
    incrementMetric(metrics, 'bunny_assignment_total', 1, assignmentMetricLabels(action, reason));
}
/**
 * What a history event of one of Bunny's tasks records for the metrics: a new task opened
 * (create) or Bunny's own cancel closing it. A cancel of a task already closed writes no event
 * and is not counted. Sends and stops are counted where they succeed instead: a send whose
 * message is never admitted is rolled back, and a stop changes no task state.
 */
function historyCall(event) {
    if (event.type === 'task.opened')
        return 'create';
    if (event.type === 'task.closed' &&
        event.payload.state === 'cancelled' &&
        event.payload.by === 'assigner')
        return 'cancel';
    return undefined;
}
/** The abnormal kind one history event records. */
function historyAbnormalKind(event) {
    if (event.type === 'task.stalled')
        return 'stalled';
    if (event.type !== 'task.round_ended')
        return undefined;
    const { state, errorKind } = event.payload;
    if (state === 'failed')
        return errorKind === 'network' ? 'network' : 'error';
    if (state === 'aborted')
        return 'stopped';
    if (state === 'interrupted')
        return 'restart';
    return undefined;
}
/** A closed task's state and the tokens it recorded, if any; undefined for other events. */
function historyClosedTask(event) {
    if (event.type !== 'task.closed')
        return undefined;
    const state = known(TASK_CLOSE_STATES, event.payload.state) ?? 'other';
    const tokens = event.payload.totalTokens;
    // Tasks closed before the history recorded tokens close without them.
    if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0)
        return { state };
    return { state, tokens };
}
/** Counts what one history write recorded for Bunny's tasks. A metric never fails the write. */
function countAssignmentHistory(metrics, events) {
    if (!metrics)
        return;
    for (const event of events) {
        if (!isBunnyAgentName(event.assignerAgentName))
            continue;
        const call = historyCall(event);
        if (call === 'create')
            incrementMetric(metrics, 'bunny_task_created_total', 1, taskCreatedLabels(event.payload));
        if (call === 'cancel')
            countAssignment(metrics, 'cancel');
        const kind = historyAbnormalKind(event);
        if (kind)
            incrementMetric(metrics, 'bunny_task_abnormal_total', 1, { kind });
        const closed = historyClosedTask(event);
        if (!closed)
            continue;
        incrementMetric(metrics, 'bunny_task_closed_total', 1, { state: closed.state });
        if (closed.tokens !== undefined)
            incrementMetric(metrics, 'bunny_task_tokens_total', closed.tokens, { state: closed.state });
    }
}
/** The history observer of the task repository: Bunny's task metrics, see the top of this file. */
export function bunnyTaskHistoryMetrics(metrics) {
    return (_tx, events) => countAssignmentHistory(metrics, events);
}
//# sourceMappingURL=assignment-metrics.js.map