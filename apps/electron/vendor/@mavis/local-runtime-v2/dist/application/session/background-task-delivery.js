import { settleInBackground } from '../../service/plugin-system/index.js';
import { requireBackgroundTaskConversation, isBackgroundTaskChildSession, } from '@mavis/agent-tools/desktop';
import { logger } from '@mavis/shared/local-runtime-logging/logger';
import { isTerminalTaskStatus } from '@mavis/background-task/local';
import { startConversationBackgroundTaskDeliveryTurn } from './background-task-conversation-delivery.js';
import { createDeliveryTaskPreview, selectDeliveryBatch, } from './background-task-delivery-batch.js';
import { isTaskDeliverySuppressed, isUserStopWindowOpen, userStopAdmissionHold, } from '../../service/background-task/index.js';
const DELIVERY_RETRY_DELAYS_MS = [1_000, 2_000, 5_000];
const DELIVERY_BURST_WINDOW_MS = 60_000;
const DELIVERY_RECOVERY_INITIAL_MS = 60_000;
const DELIVERY_RECOVERY_MAX_MS = 300_000;
const MAX_DELIVERY_TURNS_PER_WINDOW = 3;
const MAX_DELIVERY_BURST_SESSIONS = 2_048;
const MAX_ACKNOWLEDGED_TASKS = 2_048;
const deliverySchedulers = new WeakMap();
const deliveryBursts = new WeakMap();
const closedHosts = new WeakSet();
export function closeLocalBackgroundTaskDelivery(host) {
    closedHosts.add(host);
    deliverySchedulers.get(host)?.close();
}
export function scheduleLocalBackgroundTaskDelivery(host, taskId) {
    if (closedHosts.has(host))
        return;
    let scheduler = deliverySchedulers.get(host);
    if (!scheduler) {
        scheduler = new LocalBackgroundTaskDeliveryScheduler(host);
        deliverySchedulers.set(host, scheduler);
    }
    scheduler.schedule(taskId);
}
/** @internal Single-task ingress for delivery integration tests; production uses the scheduler. */
export async function startLocalBackgroundTaskDeliveryTurn(host, taskId) {
    const task = await host.backgroundTaskService.get(taskId);
    if (!shouldDeliverTask(task))
        return 'skipped';
    return deliverBatch(host, task.ownerSessionId, [createDeliveryTaskPreview(task)], [taskId]);
}
async function deliverBatch(host, ownerSessionId, previews, taskIds) {
    const session = await host.getSessionById(ownerSessionId);
    if (!mayDeliverToSession(host, session))
        return 'skipped';
    // Gate 1 (Session): a user stop for this Session is still collecting its target
    // tasks, so we cannot yet tell targets from unrelated new work. Hold the whole
    // batch as `busy` — which the scheduler retries (1s/2s/5s, then cooldown) — and
    // NOT `skipped`, which is dequeued without a reschedule and would permanently
    // lose the completion notice of a new task that happened to finish in the window.
    if (isUserStopWindowOpen(host, ownerSessionId)) {
        recordDeliverySuppressed(host, 'user_stop_window');
        logDeliverySuppressed(ownerSessionId, taskIds, 'user_stop_window');
        return 'busy';
    }
    const reservation = reserveDeliveryTurn(host, ownerSessionId);
    if (!reservation) {
        recordBurstLimit(host);
        return 'deferred';
    }
    let delivered = false;
    try {
        const snapshot = await host.backgroundTaskService.reminderSnapshot(ownerSessionId);
        // Re-read after snapshot lookup: a committed task_output may have consumed a result meanwhile.
        const candidates = await Promise.all(taskIds.map((taskId) => host.backgroundTaskService.get(taskId)));
        // Gate 2 (task): a task the user stopped never wakes this Session again, for
        // the life of the process. This is the primary "no wake-up" guarantee and does
        // not depend on the cascade finishing: it also covers a stop that timed out and
        // finished much later, and retries/cooldown batches scheduled before the stop.
        // Suppressed terminals stay undelivered, so the next turn's background reminder
        // still reports them — no information is lost.
        const suppressedIds = taskIds.filter((taskId) => isTaskDeliverySuppressed(host, taskId));
        if (suppressedIds.length > 0) {
            recordDeliverySuppressed(host, 'user_stop_target', suppressedIds.length);
            logDeliverySuppressed(ownerSessionId, suppressedIds, 'user_stop_target');
        }
        const unreadIds = new Set(candidates
            .filter((task) => shouldDeliverTask(task) &&
            task.ownerSessionId === ownerSessionId &&
            !isTaskDeliverySuppressed(host, task.taskId))
            .map((task) => task.taskId));
        const tasks = previews.filter((task) => unreadIds.has(task.taskId));
        // Every candidate was suppressed or already consumed: nothing to say, and a
        // retry would say the same thing, so `skipped` (no reschedule) is correct.
        if (closedHosts.has(host) || tasks.length === 0)
            return 'skipped';
        // Gate 1 again, after every await above. This catches a stop early and avoids
        // an unnecessary ingress call. The pre-delivery hook below is the final
        // guarantee: a window there stays `busy`; known targets become `skipped` only
        // when every task named to the model is suppressed.
        if (isUserStopWindowOpen(host, ownerSessionId)) {
            recordDeliverySuppressed(host, 'user_stop_window_recheck');
            logDeliverySuppressed(ownerSessionId, taskIds, 'user_stop_window_recheck');
            return 'busy';
        }
        const result = await startConversationBackgroundTaskDeliveryTurn({
            host,
            conversation: requireBackgroundTaskConversation(host),
            ownerSessionId,
            tasks,
            // `batchTaskIds` only forms the retry-stable idempotency key; the message's
            // `origin.taskIds` is built from `tasks`, so suppressed siblings are never
            // named to the model even though they still key this batch.
            batchTaskIds: taskIds,
            observedTerminalCount: snapshot.terminalTotal,
            holdAtAdmission: (admission) => {
                const hold = userStopAdmissionHold(host, ownerSessionId, tasks.map((task) => task.taskId));
                if (!hold)
                    return undefined;
                const count = 'suppressedIds' in hold ? hold.suppressedIds.length : 1;
                recordDeliverySuppressed(host, hold.reason, count);
                logDeliverySuppressed(ownerSessionId, 'suppressedIds' in hold ? hold.suppressedIds : taskIds, hold.reason, { ...admission, result: hold.result });
                return hold.result;
            },
        });
        delivered = result === 'delivered';
        return result;
    }
    finally {
        // Release the reserved window itself, even if the lookup crossed into a newer window.
        if (!delivered)
            reservation.delivered = Math.max(0, reservation.delivered - 1);
    }
}
function recordDeliverySuppressed(host, reason, count = 1) {
    try {
        host.metricsClient?.counter('background_task_delivery_suppressed_total', count, { reason });
    }
    catch {
        // Telemetry must not turn a deliberate suppression into a retry storm.
    }
}
function logDeliverySuppressed(ownerSessionId, taskIds, reason, admission) {
    try {
        logger.info({
            event: 'background_task_delivery_suppressed',
            sessionId: ownerSessionId,
            taskIds: [...taskIds],
            reason,
            ...(admission ?? {}),
        }, 'Suppressed local background task delivery after a user stop');
    }
    catch {
        // Diagnostics must not change the delivery result or abandon retries.
    }
}
class LocalBackgroundTaskDeliveryScheduler {
    host;
    sessions = new Map();
    lookups = new Set();
    acknowledged = new Set();
    lookupTimers = new Map();
    constructor(host) {
        this.host = host;
    }
    close() {
        for (const state of this.sessions.values())
            if (state.timer)
                clearTimeout(state.timer);
        for (const timer of this.lookupTimers.values())
            clearTimeout(timer);
        this.sessions.clear();
        this.lookupTimers.clear();
        this.acknowledged.clear();
    }
    schedule(taskId) {
        if (closedHosts.has(this.host) ||
            this.acknowledged.has(taskId) ||
            this.lookups.has(taskId) ||
            this.lookupTimers.has(taskId))
            return;
        settleInBackground(this.enqueue(taskId, 0));
    }
    async enqueue(taskId, attempts, recoveryDelayMs) {
        this.lookups.add(taskId);
        try {
            const task = await this.host.backgroundTaskService.get(taskId);
            if (closedHosts.has(this.host) || this.acknowledged.has(taskId) || !shouldDeliverTask(task))
                return;
            const preview = createDeliveryTaskPreview(task);
            let state = this.sessions.get(task.ownerSessionId);
            if (!state) {
                state = { pending: new Map(), queued: new Set(), cooling: [], inFlight: false };
                this.sessions.set(task.ownerSessionId, state);
            }
            if (state.queued.has(taskId))
                return;
            state.queued.add(taskId);
            state.pending.set(taskId, preview);
            // Lookup retries never consume the independent transport budget of this or another task.
            if (!state.inFlight && !state.batch)
                this.scheduleNext(task.ownerSessionId, state);
        }
        catch (error) {
            this.warn(taskId, error);
            this.retryLookup(taskId, attempts, recoveryDelayMs);
        }
        finally {
            this.lookups.delete(taskId);
        }
    }
    retryLookup(taskId, attempts, recoveryDelayMs) {
        const fastDelayMs = DELIVERY_RETRY_DELAYS_MS[attempts];
        const delayMs = fastDelayMs ?? nextRecoveryDelayMs(recoveryDelayMs);
        if (!closedHosts.has(this.host)) {
            const timer = setTimeout(() => {
                this.lookupTimers.delete(taskId);
                settleInBackground(this.enqueue(taskId, Math.min(attempts + 1, DELIVERY_RETRY_DELAYS_MS.length), fastDelayMs === undefined ? delayMs : undefined));
            }, delayMs);
            timer.unref?.();
            this.lookupTimers.set(taskId, timer);
        }
    }
    async run(ownerSessionId, state) {
        if (closedHosts.has(this.host) || state.inFlight)
            return;
        const batch = state.batch ?? this.takeNextBatch(state);
        if (!batch) {
            this.scheduleNext(ownerSessionId, state);
            return;
        }
        state.inFlight = true;
        state.batch = batch;
        try {
            let result;
            try {
                result = await deliverBatch(this.host, ownerSessionId, batch.previews, batch.taskIds);
            }
            catch (error) {
                this.warn(ownerSessionId, error);
                result = 'failed';
            }
            this.finishBatch(ownerSessionId, state, batch, result);
        }
        finally {
            state.inFlight = false;
        }
    }
    finishBatch(ownerSessionId, state, batch, result) {
        if (result === 'deferred') {
            this.deferBatch(ownerSessionId, state, batch);
            return;
        }
        if (result === 'failed' || result === 'busy') {
            this.retryBatch(ownerSessionId, state, batch);
            return;
        }
        for (const taskId of batch.taskIds)
            state.queued.delete(taskId);
        if (result === 'delivered' && !closedHosts.has(this.host))
            this.acknowledge(batch);
        state.batch = undefined;
        this.scheduleNext(ownerSessionId, state);
    }
    deferBatch(ownerSessionId, state, batch) {
        // An attempted batch keeps its idempotency key because a failed response may hide an ACK.
        if (batch.attempts === 0) {
            const pending = [...state.pending];
            state.pending.clear();
            for (const preview of batch.previews)
                state.pending.set(preview.taskId, preview);
            for (const [taskId, preview] of pending)
                state.pending.set(taskId, preview);
            state.batch = undefined;
        }
        this.defer(ownerSessionId, state, remainingDeliveryWindowMs(this.host, ownerSessionId));
    }
    retryBatch(ownerSessionId, state, batch) {
        const delayMs = DELIVERY_RETRY_DELAYS_MS[batch.attempts];
        if (delayMs !== undefined) {
            batch.attempts += 1;
            this.defer(ownerSessionId, state, delayMs);
            return;
        }
        // Preserve attempted batches while fresh work gets its own transport budget.
        batch.recoveryDelayMs = nextRecoveryDelayMs(batch.recoveryDelayMs);
        batch.retryAtMs = Date.now() + batch.recoveryDelayMs;
        state.cooling.push(batch);
        state.batch = undefined;
        this.scheduleNext(ownerSessionId, state);
    }
    acknowledge(batch) {
        for (const taskId of batch.taskIds) {
            this.acknowledged.add(taskId);
            if (this.acknowledged.size <= MAX_ACKNOWLEDGED_TASKS)
                continue;
            const oldest = this.acknowledged.values().next().value;
            if (oldest !== undefined)
                this.acknowledged.delete(oldest);
        }
    }
    takeNextBatch(state) {
        const due = state.cooling.findIndex((batch) => (batch.retryAtMs ?? 0) <= Date.now());
        if (due >= 0)
            return state.cooling.splice(due, 1)[0];
        if (state.pending.size === 0)
            return undefined;
        const previews = selectDeliveryBatch(state.pending);
        const taskIds = previews.map((task) => task.taskId);
        for (const taskId of taskIds)
            state.pending.delete(taskId);
        return { taskIds, previews, attempts: 0 };
    }
    scheduleNext(ownerSessionId, state) {
        if (state.pending.size > 0) {
            this.defer(ownerSessionId, state, 0);
        }
        else if (state.cooling.length > 0) {
            const next = state.cooling.reduce((earliest, batch) => Math.min(earliest, batch.retryAtMs ?? Date.now()), Number.POSITIVE_INFINITY);
            this.defer(ownerSessionId, state, Math.max(0, next - Date.now()));
        }
        else {
            this.sessions.delete(ownerSessionId);
        }
    }
    defer(ownerSessionId, state, delayMs) {
        if (closedHosts.has(this.host))
            return;
        const timerAtMs = Date.now() + delayMs;
        if (state.timer && state.timerAtMs !== undefined && state.timerAtMs <= timerAtMs)
            return;
        if (state.timer)
            clearTimeout(state.timer);
        state.timerAtMs = timerAtMs;
        state.timer = setTimeout(() => {
            state.timer = undefined;
            state.timerAtMs = undefined;
            settleInBackground(this.run(ownerSessionId, state));
        }, delayMs);
        state.timer.unref?.();
    }
    warn(identity, error) {
        const noticeIdentity = identity.length <= 160 ? identity : `${identity.slice(0, 160)}…`;
        try {
            this.host.matrixLogger?.warn({ sessionId: 'local-background-task-delivery', turnId: noticeIdentity }, `Local background task delivery failed for ${noticeIdentity}: ${error instanceof Error ? error.message : String(error)}`);
        }
        catch {
            // Diagnostic sinks cannot abandon an accepted notification or its bounded retries.
        }
    }
}
function nextRecoveryDelayMs(previousMs) {
    return Math.min(previousMs === undefined ? DELIVERY_RECOVERY_INITIAL_MS : previousMs * 2, DELIVERY_RECOVERY_MAX_MS);
}
function remainingDeliveryWindowMs(host, ownerSessionId) {
    const burst = deliveryBursts.get(host)?.get(ownerSessionId);
    const remainingMs = burst && burst.delivered >= MAX_DELIVERY_TURNS_PER_WINDOW
        ? Math.max(0, burst.windowStartedAt + DELIVERY_BURST_WINDOW_MS - host.nowMs())
        : 0;
    return remainingMs + 1 + Math.floor(Math.random() * 100);
}
function shouldDeliverTask(task) {
    return !!task && isTerminalTaskStatus(task.status) && task.deliveredAt === undefined;
}
function reserveDeliveryTurn(host, ownerSessionId) {
    const burst = getDeliveryBurst(host, ownerSessionId);
    if (burst.delivered >= MAX_DELIVERY_TURNS_PER_WINDOW)
        return undefined;
    burst.delivered += 1;
    return burst;
}
function getDeliveryBurst(host, ownerSessionId) {
    let bySession = deliveryBursts.get(host);
    if (!bySession) {
        bySession = new Map();
        deliveryBursts.set(host, bySession);
    }
    const now = host.nowMs();
    const existing = bySession.get(ownerSessionId);
    if (existing && now - existing.windowStartedAt < DELIVERY_BURST_WINDOW_MS) {
        bySession.delete(ownerSessionId);
        bySession.set(ownerSessionId, existing);
        return existing;
    }
    const fresh = { windowStartedAt: now, delivered: 0 };
    bySession.set(ownerSessionId, fresh);
    if (bySession.size > MAX_DELIVERY_BURST_SESSIONS) {
        const oldest = bySession.keys().next().value;
        if (oldest !== undefined)
            bySession.delete(oldest);
    }
    return fresh;
}
function recordBurstLimit(host) {
    try {
        host.metricsClient?.counter('background_task_delivery_suppressed_total', 1, {
            reason: 'session_burst_limit',
        });
    }
    catch {
        // Telemetry must not turn a deliberate suppression into a retry storm.
    }
}
function mayDeliverToSession(host, session) {
    return !closedHosts.has(host) && !!session && !isBackgroundTaskChildSession(session);
}
//# sourceMappingURL=background-task-delivery.js.map