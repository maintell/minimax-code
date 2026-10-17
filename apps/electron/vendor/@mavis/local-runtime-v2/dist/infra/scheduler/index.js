import { randomUUID } from 'node:crypto';
import { Cron } from 'croner';
import { eq, sql } from 'drizzle-orm';
import { schedulerJobs, } from '../db/schema/scheduler.js';
class ScheduleHasNoFutureRunError extends Error {
    code = 'SCHEDULER_INVALID';
}
export class Scheduler {
    options;
    handlers = new Map();
    jobs = new Map();
    timers = new Map();
    nowMs;
    started = false;
    constructor(options) {
        this.options = options;
        this.nowMs = options.nowMs ?? Date.now;
    }
    registerHandler(handlerKey, handler) {
        if (this.started)
            throw new Error('scheduler handlers must be registered before start');
        if (handlerKey.trim() === '')
            throw new Error('scheduler handler key must not be empty');
        if (this.handlers.has(handlerKey)) {
            throw new Error(`scheduler handler already registered: ${handlerKey}`);
        }
        this.handlers.set(handlerKey, handler);
    }
    start(startOptions = {}) {
        if (this.started)
            return;
        this.started = true;
        try {
            this.restoreActiveJobs(startOptions.restorePersistedJobExecution !== false);
            this.reportActiveJobs();
        }
        catch (error) {
            for (const timer of this.timers.values())
                timer.stop();
            this.timers.clear();
            this.jobs.clear();
            this.started = false;
            throw error;
        }
    }
    stop() {
        for (const timer of this.timers.values())
            timer.stop();
        this.timers.clear();
        this.jobs.clear();
        this.started = false;
        this.reportActiveJobs();
    }
    schedule(handlerKey, schedule) {
        const handler = this.handlers.get(handlerKey);
        if (!handler)
            throw new Error(`scheduler handler is not registered: ${handlerKey}`);
        this.requireStarted();
        const normalized = normalizeSchedule(schedule, this.nowMs(), false);
        const schedulerId = randomUUID();
        const now = this.nowMs();
        const record = {
            schedulerId,
            handlerKey,
            schedule: normalized,
            scheduleGeneration: 0,
            runCount: 0,
            state: 'active',
            createdAtMs: now,
            updatedAtMs: now,
        };
        const { timer, nextRunAtMs } = this.createTimer(record);
        record.nextRunAtMs = nextRunAtMs;
        try {
            insertJob(this.options.db, record);
        }
        catch (error) {
            timer.stop();
            throw error;
        }
        this.jobs.set(schedulerId, record);
        this.timers.set(schedulerId, timer);
        timer.resume();
        this.reportActiveJobs();
        return schedulerId;
    }
    reschedule(schedulerId, schedule) {
        this.requireStarted();
        const current = this.jobs.get(schedulerId);
        if (!current)
            throw new Error(`scheduler job not found: ${schedulerId}`);
        if (!this.handlers.has(current.handlerKey)) {
            throw new Error(`scheduler handler is not registered: ${current.handlerKey}`);
        }
        const normalized = normalizeSchedule(schedule, this.nowMs(), false);
        const next = {
            ...current,
            schedule: normalized,
            scheduleGeneration: nextScheduleGeneration(current.scheduleGeneration),
            runCount: 0,
            state: 'active',
            nextRunAtMs: undefined,
            updatedAtMs: this.nowMs(),
        };
        const { timer: nextTimer, nextRunAtMs } = this.createTimer(next);
        next.nextRunAtMs = nextRunAtMs;
        try {
            updateJob(this.options.db, next);
        }
        catch (error) {
            nextTimer.stop();
            throw error;
        }
        this.timers.get(schedulerId)?.stop();
        this.jobs.set(schedulerId, next);
        this.timers.set(schedulerId, nextTimer);
        nextTimer.resume();
        this.reportActiveJobs();
    }
    cancel(schedulerId) {
        this.requireStarted();
        const current = this.jobs.get(schedulerId);
        if (!current || current.state === 'cancelled')
            return;
        const cancelled = {
            ...current,
            state: 'cancelled',
            nextRunAtMs: undefined,
            updatedAtMs: this.nowMs(),
        };
        updateJob(this.options.db, cancelled);
        this.timers.get(schedulerId)?.stop();
        this.timers.delete(schedulerId);
        this.jobs.set(schedulerId, cancelled);
        this.reportActiveJobs();
    }
    get(schedulerId) {
        this.requireStarted();
        const record = this.jobs.get(schedulerId);
        if (record && !this.timers.has(schedulerId)) {
            this.refreshRecurringInspectionState(record);
        }
        return record ? cloneJob(record) : undefined;
    }
    /**
     * Reads the durable Scheduler fact without adopting it into this runtime's execution state.
     * Cron queries use this boundary so a stale owner Map cannot hide an existing definition.
     */
    inspect(schedulerId) {
        const db = this.requireStarted();
        const owned = this.jobs.get(schedulerId);
        const row = readStoredJobRow(db, schedulerId);
        if (!row) {
            if (owned)
                this.reportConsistencyMismatch('map_only');
            return undefined;
        }
        const persisted = parseStoredJobRow(row, this.nowMs());
        if (!persisted) {
            this.reportSkipped('invalid_record');
            return undefined;
        }
        if (!owned) {
            this.reportConsistencyMismatch('db_only');
        }
        else if (!sameJob(owned, persisted)) {
            this.reportConsistencyMismatch('diverged');
        }
        return cloneJob(this.readCurrentRecurringState(persisted));
    }
    remove(schedulerId) {
        this.requireStarted();
        const result = this.options.db
            .delete(schedulerJobs)
            .where(eq(schedulerJobs.schedulerId, schedulerId))
            .run();
        this.timers.get(schedulerId)?.stop();
        this.timers.delete(schedulerId);
        const existedInMemory = this.jobs.delete(schedulerId);
        this.reportActiveJobs();
        return readChanges(result) > 0 || existedInMemory;
    }
    restoreActiveJobs(restoreExecution) {
        const db = this.requireStarted();
        // Read JSON as raw text so one malformed row cannot make Drizzle reject the
        // entire result set before Scheduler can isolate and report that row.
        const rows = db.select(STORED_JOB_SELECTION).from(schedulerJobs).all();
        for (const row of rows) {
            const record = parseStoredJobRow(row, this.nowMs());
            if (!record) {
                this.reportSkipped('invalid_record');
                continue;
            }
            this.jobs.set(record.schedulerId, record);
            if (restoreExecution) {
                this.restoreJob(record);
            }
            else {
                this.refreshRecurringInspectionState(record);
            }
        }
    }
    refreshRecurringInspectionState(record) {
        const current = this.readCurrentRecurringState(record);
        if (current === record)
            return;
        record.nextRunAtMs = current.nextRunAtMs;
        record.updatedAtMs = this.nowMs();
        updateJob(this.options.db, record);
    }
    readCurrentRecurringState(record) {
        if (record.state !== 'active' || record.schedule.kind !== 'cron')
            return record;
        const nowMs = this.nowMs();
        if (record.nextRunAtMs !== undefined && record.nextRunAtMs > nowMs)
            return record;
        let timer;
        let nextRunAtMs;
        try {
            ({ timer, nextRunAtMs } = this.createTimer(record, nowMs));
        }
        catch {
            this.reportSkipped('invalid_schedule');
            return record;
        }
        timer.stop();
        if (record.nextRunAtMs === nextRunAtMs)
            return record;
        return { ...record, nextRunAtMs };
    }
    restoreJob(record) {
        if (record.state !== 'active')
            return;
        if (record.schedule.kind === 'once' && record.schedule.runAtMs <= this.nowMs()) {
            this.expireOnce(record);
            return;
        }
        if (hasReachedMaxRuns(record)) {
            record.state = 'completed';
            record.nextRunAtMs = undefined;
            record.updatedAtMs = this.nowMs();
            updateJob(this.options.db, record);
            return;
        }
        if (!this.handlers.has(record.handlerKey)) {
            this.reportSkipped('missing_handler');
            return;
        }
        this.restoreTimer(record);
    }
    restoreTimer(record) {
        let timer;
        let nextRunAtMs;
        try {
            ({ timer, nextRunAtMs } = this.createTimer(record));
        }
        catch (error) {
            if (error instanceof ScheduleHasNoFutureRunError && record.schedule.kind === 'once') {
                this.expireOnce(record);
            }
            else {
                this.reportSkipped('invalid_schedule');
            }
            return;
        }
        record.nextRunAtMs = nextRunAtMs;
        record.updatedAtMs = this.nowMs();
        try {
            updateJob(this.options.db, record);
        }
        catch (error) {
            timer.stop();
            throw error;
        }
        this.timers.set(record.schedulerId, timer);
        timer.resume();
    }
    createTimer(record, nextRunAfterMs) {
        const pattern = record.schedule.kind === 'once'
            ? new Date(record.schedule.runAtMs)
            : record.schedule.expression;
        const timezone = record.schedule.kind === 'cron' ? record.schedule.timezone : undefined;
        const timer = new Cron(pattern, {
            timezone,
            paused: true,
            unref: true,
            protect: () => this.reportSkipped('overlap'),
            catch: () => this.reportSkipped('trigger_error'),
        }, async (cron) => {
            await this.trigger(record.schedulerId, cron);
        });
        const nextRun = nextRunAfterMs === undefined ? timer.nextRun() : timer.nextRun(new Date(nextRunAfterMs));
        if (nextRun === null) {
            timer.stop();
            throw new ScheduleHasNoFutureRunError('schedule has no future run');
        }
        return { timer, nextRunAtMs: nextRun.getTime() };
    }
    expireOnce(record) {
        record.state = 'expired';
        record.nextRunAtMs = undefined;
        record.updatedAtMs = this.nowMs();
        updateJob(this.options.db, record);
        this.reportSkipped('expired_once');
    }
    async trigger(schedulerId, timer) {
        const active = this.getActiveTrigger(schedulerId, timer);
        if (!active)
            return;
        const next = this.advanceJob(active.record, timer);
        this.persistTriggeredJob(next, timer);
        this.jobs.set(schedulerId, next);
        if (next.state === 'completed') {
            timer.stop();
            this.timers.delete(schedulerId);
        }
        this.reportActiveJobs();
        await this.invokeHandler(next);
    }
    getActiveTrigger(schedulerId, timer) {
        if (this.timers.get(schedulerId) !== timer)
            return undefined;
        const record = this.jobs.get(schedulerId);
        if (!record || record.state !== 'active')
            return undefined;
        return { record };
    }
    advanceJob(record, timer) {
        const next = {
            ...record,
            runCount: record.runCount + 1,
            updatedAtMs: this.nowMs(),
        };
        if (next.schedule.kind === 'once' || hasReachedMaxRuns(next)) {
            next.state = 'completed';
            next.nextRunAtMs = undefined;
        }
        else {
            next.nextRunAtMs = timer.nextRun()?.getTime();
        }
        return next;
    }
    persistTriggeredJob(record, timer) {
        try {
            updateJob(this.options.db, record);
        }
        catch (error) {
            if (record.schedule.kind === 'once') {
                timer.stop();
                this.timers.delete(record.schedulerId);
                this.reportActiveJobs();
            }
            throw error;
        }
    }
    async invokeHandler(record) {
        const handler = this.handlers.get(record.handlerKey);
        if (!handler) {
            this.reportSkipped('missing_handler');
            return;
        }
        const startedAtMs = this.nowMs();
        try {
            await handler(record.schedulerId);
            this.reportTrigger(record.handlerKey, 'success', startedAtMs);
        }
        catch {
            this.reportTrigger(record.handlerKey, 'failure', startedAtMs);
        }
    }
    requireStarted() {
        if (!this.started)
            throw new Error('scheduler has not started');
        return this.options.db;
    }
    reportActiveJobs() {
        this.reportMetric(() => this.options.metrics?.gauge('scheduler_active_jobs', this.timers.size));
    }
    reportSkipped(reason) {
        this.reportMetric(() => this.options.metrics?.counter('scheduler_skipped_total', 1, { reason }));
    }
    reportConsistencyMismatch(kind) {
        this.reportMetric(() => this.options.metrics?.counter('scheduler_consistency_mismatch_total', 1, { kind }));
    }
    reportTrigger(handlerKey, outcome, startedAtMs) {
        const labels = { handlerKey, outcome };
        this.reportMetric(() => this.options.metrics?.counter('scheduler_trigger_total', 1, labels));
        this.reportMetric(() => this.options.metrics?.histogram('scheduler_callback_duration_ms', Math.max(0, this.nowMs() - startedAtMs), labels));
    }
    reportMetric(report) {
        try {
            report();
        }
        catch {
            // Metrics are best-effort and must never change Scheduler behavior.
        }
    }
}
function hasReachedMaxRuns(record) {
    return (record.schedule.kind === 'cron' &&
        record.schedule.maxRuns !== undefined &&
        record.runCount >= record.schedule.maxRuns);
}
function normalizeSchedule(schedule, nowMs, allowPastOnce) {
    if (!isRecord(schedule))
        throw new Error('scheduler schedule must be an object');
    if (schedule.kind === 'once')
        return normalizeOnce(schedule, nowMs, allowPastOnce);
    if (schedule.kind === 'cron')
        return normalizeCronSchedule(schedule);
    throw new Error('scheduler schedule kind must be once or cron');
}
function normalizeOnce(schedule, nowMs, allowPast) {
    if (!Number.isSafeInteger(schedule.runAtMs)) {
        throw new Error('once schedule runAtMs must be a Unix millisecond integer');
    }
    const runAtMs = schedule.runAtMs;
    if (!allowPast && runAtMs <= nowMs) {
        throw new Error('once schedule runAtMs must be in the future');
    }
    return { kind: 'once', runAtMs };
}
function normalizeCronSchedule(schedule) {
    const expression = readCronExpression(schedule.expression);
    const timezone = readCronTimezone(schedule.timezone);
    const maxRuns = readCronMaxRuns(schedule.maxRuns);
    return {
        kind: 'cron',
        expression,
        ...(timezone === undefined ? {} : { timezone }),
        ...(maxRuns === undefined ? {} : { maxRuns }),
    };
}
function readCronExpression(value) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error('cron schedule expression must not be empty');
    }
    return value;
}
function readCronTimezone(value) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error('cron schedule timezone must not be empty');
    }
    return value;
}
function readCronMaxRuns(value) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw new Error('cron schedule maxRuns must be a positive integer');
    }
    return value;
}
function parseJobRow(row, nowMs) {
    if (!isValidJobRow(row))
        return undefined;
    try {
        const schedule = normalizeSchedule(row.scheduleJson, nowMs, true);
        return {
            schedulerId: row.schedulerId,
            handlerKey: row.handlerKey,
            schedule,
            scheduleGeneration: row.scheduleGeneration,
            runCount: row.runCount,
            state: row.state,
            ...(Number.isSafeInteger(row.nextRunAtMs) ? { nextRunAtMs: row.nextRunAtMs } : {}),
            createdAtMs: row.createdAtMs,
            updatedAtMs: row.updatedAtMs,
        };
    }
    catch {
        return undefined;
    }
}
function parseStoredJobRow(row, nowMs) {
    try {
        return parseJobRow({ ...row, scheduleJson: JSON.parse(row.scheduleJsonText) }, nowMs);
    }
    catch {
        return undefined;
    }
}
const STORED_JOB_SELECTION = {
    schedulerId: schedulerJobs.schedulerId,
    handlerKey: schedulerJobs.handlerKey,
    scheduleJsonText: sql `${schedulerJobs.scheduleJson}`,
    scheduleGeneration: schedulerJobs.scheduleGeneration,
    runCount: schedulerJobs.runCount,
    state: schedulerJobs.state,
    nextRunAtMs: schedulerJobs.nextRunAtMs,
    createdAtMs: schedulerJobs.createdAtMs,
    updatedAtMs: schedulerJobs.updatedAtMs,
};
function readStoredJobRow(db, schedulerId) {
    return db
        .select(STORED_JOB_SELECTION)
        .from(schedulerJobs)
        .where(eq(schedulerJobs.schedulerId, schedulerId))
        .get();
}
function sameJob(left, right) {
    return (left.schedulerId === right.schedulerId &&
        left.handlerKey === right.handlerKey &&
        sameSchedule(left.schedule, right.schedule) &&
        left.scheduleGeneration === right.scheduleGeneration &&
        left.runCount === right.runCount &&
        left.state === right.state &&
        left.nextRunAtMs === right.nextRunAtMs &&
        left.createdAtMs === right.createdAtMs &&
        left.updatedAtMs === right.updatedAtMs);
}
function sameSchedule(left, right) {
    if (left.kind !== right.kind)
        return false;
    if (left.kind === 'once')
        return right.kind === 'once' && left.runAtMs === right.runAtMs;
    return (right.kind === 'cron' &&
        left.expression === right.expression &&
        left.timezone === right.timezone &&
        left.maxRuns === right.maxRuns);
}
function isValidJobRow(row) {
    return (typeof row.schedulerId === 'string' &&
        typeof row.handlerKey === 'string' &&
        typeof row.scheduleJson === 'object' &&
        row.scheduleJson !== null &&
        Number.isSafeInteger(row.scheduleGeneration) &&
        row.scheduleGeneration >= 0 &&
        Number.isSafeInteger(row.runCount) &&
        isJobState(row.state) &&
        Number.isSafeInteger(row.createdAtMs) &&
        Number.isSafeInteger(row.updatedAtMs));
}
function isJobState(value) {
    return (value === 'active' || value === 'completed' || value === 'expired' || value === 'cancelled');
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function cloneJob(record) {
    return { ...record, schedule: { ...record.schedule } };
}
function readChanges(result) {
    return typeof result === 'object' && result !== null && 'changes' in result
        ? Number(result.changes)
        : 0;
}
function insertJob(db, record) {
    db.insert(schedulerJobs)
        .values({
        schedulerId: record.schedulerId,
        handlerKey: record.handlerKey,
        scheduleJson: record.schedule,
        scheduleGeneration: record.scheduleGeneration,
        runCount: record.runCount,
        state: record.state,
        nextRunAtMs: record.nextRunAtMs ?? null,
        createdAtMs: record.createdAtMs,
        updatedAtMs: record.updatedAtMs,
    })
        .run();
}
function updateJob(db, record) {
    db.update(schedulerJobs)
        .set({
        scheduleJson: record.schedule,
        scheduleGeneration: record.scheduleGeneration,
        runCount: record.runCount,
        state: record.state,
        nextRunAtMs: record.nextRunAtMs ?? null,
        updatedAtMs: record.updatedAtMs,
    })
        .where(eq(schedulerJobs.schedulerId, record.schedulerId))
        .run();
}
function nextScheduleGeneration(current) {
    const next = current + 1;
    if (!Number.isSafeInteger(next))
        throw new Error('scheduler generation is exhausted');
    return next;
}
//# sourceMappingURL=index.js.map