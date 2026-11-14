import { ATTENTION_ASSIGNMENT_STATES } from '../contracts.js';
import { TASK_CATEGORY_LABEL, TASK_CLOSED_LABEL, TASK_CLOSURE_LABEL, TASK_STATE_LABEL, taskCountLine, taskRemovedRow, } from '../../coordinator-text/index.js';
/** Task rows a delta block writes out; further changed tasks are only counted (spec 9.3). */
const MAX_TASK_ROWS = 10;
/** Baseline key prefix of a task. */
export const TASK_KEY = 'task:';
/** A task counted instead of listed: known, not delivered, sent again next time. */
export const UNDELIVERED = 'pending';
const CATEGORY_RANK = { attention: 0, error: 1, ended: 2, running: 3 };
/**
 * The task section of a delta block (spec 9.2-9.4). Each row is the task's
 * current state; a task leaving a state gets a row too. Without a baseline every
 * open task and every task that ended since the previous Turn is listed. More
 * than ten rows: the first ten by "等你处理 > 出错 > 刚结束 > 进行中", the rest
 * counted by category and not delivered, so later blocks send them again.
 */
export function renderTaskDelta(input) {
    const updates = new Map();
    const rows = [...changedRows(input, updates), ...removedRows(input)];
    rows.sort((a, b) => CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category] || b.at - a.at);
    const shown = rows.slice(0, MAX_TASK_ROWS);
    const counted = rows.slice(MAX_TASK_ROWS);
    for (const row of shown)
        updates.set(row.key, row.fingerprint);
    // A counted task new to the baseline is recorded as undelivered, so it is never
    // mistaken later for one Bunny dispatched and already knows about.
    for (const row of counted)
        if (!input.baseline?.has(row.key))
            updates.set(row.key, UNDELIVERED);
    return {
        lines: [...shown.map((row) => row.line), ...countLine(counted)],
        updates,
        listed: shown.length,
        undelivered: counted.length,
    };
}
/** A row for each task whose state differs from the baseline; silent ones go to `updates`. */
function changedRows(input, updates) {
    const rows = [];
    for (const task of input.tasks) {
        const key = taskKey(task);
        const fingerprint = taskFingerprint(task);
        const previous = input.baseline?.get(key);
        if (previous === fingerprint)
            continue;
        if (isSilent(task, input, previous, fingerprint)) {
            updates.set(key, fingerprint);
            continue;
        }
        rows.push({
            key,
            fingerprint,
            category: categoryOf(task),
            line: input.render(task, transitionLabel(task, previous, fingerprint) ?? stateLabel(task)),
            at: task.assignment?.completion?.at ?? task.session.updatedAtMs,
        });
    }
    return rows;
}
/** A row for each delivered task the view no longer has: archived or deleted. */
function removedRows(input) {
    if (input.partial)
        return [];
    const present = new Set(input.tasks.map(taskKey));
    return [...(input.baseline ?? [])]
        .filter(([key]) => key.startsWith(TASK_KEY) && !present.has(key))
        .map(([key]) => ({
        key,
        fingerprint: null,
        category: 'ended',
        line: taskRemovedRow(key.slice(TASK_KEY.length)),
        at: 0,
    }));
}
function taskKey(task) {
    return `${TASK_KEY}${task.session.sessionId}`;
}
/** A task's delivered state: what a later block compares against. */
function taskFingerprint(task) {
    const completion = task.assignment?.completion;
    if (completion)
        return ['ended', completion.state, completion.by, completion.reason].filter(Boolean).join(':');
    if (task.state === 'failed')
        return 'error';
    if (ATTENTION_ASSIGNMENT_STATES.has(task.state))
        return `attention:${task.state}`;
    // Entering or leaving a stall, or a new reason for it, is a change Bunny sees (R5.5).
    if (task.stalled)
        return `running:stalled:${task.stallReason ?? ''}`;
    return 'running';
}
function isSilent(task, input, previous, fingerprint) {
    if (input.explained.has(task.session.sessionId))
        return true;
    if (!input.baseline) {
        // A full block lists open tasks and the ones that ended since the previous Turn.
        const closedAt = task.assignment?.completion?.at;
        return (closedAt !== undefined &&
            (input.previousTurnStartedAt === undefined || closedAt <= input.previousTurnStartedAt));
    }
    // Bunny's own dispatch, cancel and takeover are in its history already (spec 9.2).
    const completion = task.assignment?.completion;
    if (completion?.by === 'assigner' && completion.state !== 'completed')
        return true;
    return (previous === undefined &&
        fingerprint === 'running' &&
        task.assignment?.assignerSessionId === input.sessionId);
}
function categoryOf(task) {
    const fingerprint = taskFingerprint(task);
    if (fingerprint.startsWith('ended:'))
        return 'ended';
    if (fingerprint === 'error')
        return 'error';
    if (fingerprint.startsWith('attention:'))
        return 'attention';
    return 'running';
}
function isStalledFingerprint(fingerprint) {
    return fingerprint?.startsWith('running:stalled:') === true;
}
/** Leaving a state is written as its own row (spec 9.3). */
function transitionLabel(task, previous, fingerprint) {
    const completion = task.assignment?.completion;
    if (completion)
        return closureLabel(completion);
    if (fingerprint === 'running' &&
        previous !== undefined &&
        (previous === 'error' || previous.startsWith('attention:')))
        return TASK_STATE_LABEL.recovered;
    if (fingerprint === 'running' && isStalledFingerprint(previous))
        return TASK_STATE_LABEL.unstalled;
    return undefined;
}
function closureLabel(completion) {
    if (completion.reason)
        return TASK_CLOSURE_LABEL[completion.reason];
    return completion.state === 'cancelled' ? TASK_CLOSURE_LABEL.cancelled : TASK_CLOSED_LABEL;
}
function stateLabel(task) {
    if (task.state === 'waiting_approval')
        return TASK_STATE_LABEL.waitingApproval;
    if (task.state === 'failed')
        return TASK_STATE_LABEL.failed;
    if (task.state === 'review_failed')
        return TASK_STATE_LABEL.reviewFailed;
    if (ATTENTION_ASSIGNMENT_STATES.has(task.state))
        return TASK_STATE_LABEL.attention;
    if (task.assignment?.pendingStart || task.state === 'queued')
        return TASK_STATE_LABEL.queued;
    if (task.state === 'running')
        return task.stalled ? TASK_STATE_LABEL.stalled : TASK_STATE_LABEL.running;
    return TASK_STATE_LABEL.reviewing;
}
function countLine(counted) {
    if (counted.length === 0)
        return [];
    const counts = new Map();
    for (const row of counted)
        counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
    const categories = Object.keys(CATEGORY_RANK)
        .filter((category) => counts.has(category))
        .map((category) => ({ label: TASK_CATEGORY_LABEL[category], count: counts.get(category) }));
    return [taskCountLine(counted.length, categories)];
}
//# sourceMappingURL=task-delta.js.map