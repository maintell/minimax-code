import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { and, asc, desc, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { cronDefinitions, cronRuns } from '../../../infra/db/schema/cron.js';
import { CronRepositoryError } from '../errors.js';
import {} from '../contracts.js';
import { changes, invalid, text, timestamp } from './definition.repository.js';
export class SqliteCronRunRepository {
    db;
    generateId;
    constructor(db, generateId = randomUUID) {
        this.db = db;
        this.generateId = generateId;
    }
    insertPendingManualForDefinition(cronId, createdAtMs, requestId) {
        const manualRunId = text(this.generateId(), 'runId');
        const manualRequestId = requestId === undefined ? null : text(requestId, 'requestId');
        const activeCronId = text(cronId, 'cronId');
        timestamp(createdAtMs, 'createdAtMs');
        const activeDefinition = this.db
            .select({
            runId: sql `${manualRunId}`.as('run_id'),
            cronId: cronDefinitions.cronId,
            schedulerTriggerId: sql `NULL`.as('scheduler_trigger_id'),
            manualRequestId: sql `${manualRequestId}`.as('manual_request_id'),
            triggerSource: sql `'manual'`.as('trigger_source'),
            sessionId: sql `NULL`.as('session_id'),
            status: sql `'pending'`.as('status'),
            createdAtMs: sql `${createdAtMs}`.as('created_at_ms'),
            executionClaimedAtMs: sql `NULL`.as('execution_claimed_at_ms'),
            deliveredAtMs: sql `NULL`.as('delivered_at_ms'),
            failedAtMs: sql `NULL`.as('failed_at_ms'),
            errorCode: sql `NULL`.as('error_code'),
            error: sql `NULL`.as('error'),
            deliveryInputJson: sql `NULL`.as('delivery_input_json'),
            retryAtMs: sql `NULL`.as('retry_at_ms'),
            retryAttempt: sql `0`.as('retry_attempt'),
        })
            .from(cronDefinitions)
            .where(and(eq(cronDefinitions.cronId, activeCronId), isNull(cronDefinitions.deletedAtMs)));
        const result = this.db.insert(cronRuns).select(activeDefinition).run();
        if (changes(result) !== 1) {
            throw new CronRepositoryError('CRON_NOT_FOUND', 'Cron definition not found');
        }
        return this.require(manualRunId);
    }
    insertPendingScheduled(cronId, schedulerTriggerId, createdAtMs) {
        text(cronId, 'cronId');
        text(schedulerTriggerId, 'schedulerTriggerId');
        const existing = this.getBySchedulerTriggerId(schedulerTriggerId);
        if (existing) {
            if (existing.cronId !== cronId || existing.triggerSource !== 'scheduled') {
                throw new CronRepositoryError('CRON_CONFLICT', 'Scheduler trigger is bound to another Cron run');
            }
            return existing;
        }
        try {
            return this.insertPending({
                runId: this.generateId(),
                cronId,
                schedulerTriggerId,
                triggerSource: 'scheduled',
                createdAtMs,
            });
        }
        catch (error) {
            const raced = this.getBySchedulerTriggerId(schedulerTriggerId);
            if (raced?.cronId === cronId && raced.triggerSource === 'scheduled')
                return raced;
            throw error;
        }
    }
    get(runId) {
        text(runId, 'runId');
        const row = this.db.select().from(cronRuns).where(eq(cronRuns.runId, runId)).get();
        return row ? mapRun(row) : undefined;
    }
    getByManualRequestId(requestId) {
        text(requestId, 'requestId');
        const row = this.db
            .select()
            .from(cronRuns)
            .where(eq(cronRuns.manualRequestId, requestId))
            .get();
        return row ? mapRun(row) : undefined;
    }
    getBySchedulerTriggerId(schedulerTriggerId) {
        text(schedulerTriggerId, 'schedulerTriggerId');
        const row = this.db
            .select()
            .from(cronRuns)
            .where(eq(cronRuns.schedulerTriggerId, schedulerTriggerId))
            .get();
        return row ? mapRun(row) : undefined;
    }
    listPage(query) {
        text(query.cronId, 'cronId');
        if (!Number.isSafeInteger(query.take) || query.take <= 0)
            invalid('take is invalid');
        const filters = [eq(cronRuns.cronId, query.cronId)];
        if (query.before) {
            timestamp(query.before.createdAtMs, 'before.createdAtMs');
            text(query.before.runId, 'before.runId');
            filters.push(or(lt(cronRuns.createdAtMs, query.before.createdAtMs), and(eq(cronRuns.createdAtMs, query.before.createdAtMs), lt(cronRuns.runId, query.before.runId))));
        }
        return this.db
            .select()
            .from(cronRuns)
            .where(and(...filters))
            .orderBy(desc(cronRuns.createdAtMs), desc(cronRuns.runId))
            .limit(query.take)
            .all()
            .map(mapRun);
    }
    listPending() {
        return this.db
            .select()
            .from(cronRuns)
            .where(eq(cronRuns.status, 'pending'))
            .orderBy(asc(cronRuns.createdAtMs), asc(cronRuns.runId))
            .all()
            .map(mapRun);
    }
    hasPendingForCronId(cronId) {
        text(cronId, 'cronId');
        return (this.db
            .select({ present: sql `1` })
            .from(cronRuns)
            .where(and(eq(cronRuns.cronId, cronId), eq(cronRuns.status, 'pending')))
            .limit(1)
            .get() !== undefined);
    }
    claimExecution(runId, claimedAtMs) {
        text(runId, 'runId');
        timestamp(claimedAtMs, 'claimedAtMs');
        const result = this.db
            .update(cronRuns)
            .set({ executionClaimedAtMs: claimedAtMs })
            .where(and(eq(cronRuns.runId, runId), eq(cronRuns.status, 'pending'), isNull(cronRuns.executionClaimedAtMs)))
            .run();
        return changes(result) === 1 ? this.require(runId) : undefined;
    }
    attachSession(runId, sessionId, deliveryInput) {
        text(runId, 'runId');
        text(sessionId, 'sessionId');
        const result = this.db
            .update(cronRuns)
            .set({ sessionId, deliveryInputJson: deliveryInput ? JSON.stringify(deliveryInput) : null })
            .where(and(eq(cronRuns.runId, runId), eq(cronRuns.status, 'pending'), isNull(cronRuns.sessionId), isNotNull(cronRuns.executionClaimedAtMs)))
            .run();
        if (changes(result) === 1)
            return true;
        const current = this.get(runId);
        return (current?.status === 'pending' &&
            current.sessionId === sessionId &&
            current.executionClaimedAtMs !== undefined);
    }
    deferDelivery(runId, retryAtMs) {
        timestamp(retryAtMs, 'retryAtMs');
        return (changes(this.db
            .update(cronRuns)
            .set({ retryAtMs, retryAttempt: sql `${cronRuns.retryAttempt} + 1` })
            .where(and(eq(cronRuns.runId, runId), eq(cronRuns.status, 'pending'), isNotNull(cronRuns.sessionId), isNotNull(cronRuns.deliveryInputJson)))
            .run()) === 1);
    }
    markDelivered(runId, deliveredAtMs) {
        text(runId, 'runId');
        timestamp(deliveredAtMs, 'deliveredAtMs');
        const result = this.db
            .update(cronRuns)
            .set({ status: 'delivered', deliveredAtMs, retryAtMs: null })
            .where(and(eq(cronRuns.runId, runId), eq(cronRuns.status, 'pending'), isNotNull(cronRuns.sessionId), isNotNull(cronRuns.executionClaimedAtMs)))
            .run();
        if (changes(result) === 1)
            return true;
        return sameTerminal(this.get(runId), 'delivered');
    }
    markFailed(input) {
        text(input.runId, 'runId');
        timestamp(input.failedAtMs, 'failedAtMs');
        text(input.errorCode, 'errorCode');
        const result = this.db
            .update(cronRuns)
            .set({
            status: 'failed',
            retryAtMs: null,
            failedAtMs: input.failedAtMs,
            errorCode: input.errorCode,
            error: input.error ?? null,
        })
            .where(and(eq(cronRuns.runId, input.runId), eq(cronRuns.status, 'pending'), isNotNull(cronRuns.executionClaimedAtMs)))
            .run();
        if (changes(result) === 1)
            return true;
        return sameTerminal(this.get(input.runId), 'failed');
    }
    deleteByCronId(cronId) {
        text(cronId, 'cronId');
        return changes(this.db.delete(cronRuns).where(eq(cronRuns.cronId, cronId)).run());
    }
    insertPending(input) {
        const runId = text(input.runId, 'runId');
        const cronId = text(input.cronId, 'cronId');
        timestamp(input.createdAtMs, 'createdAtMs');
        this.db
            .insert(cronRuns)
            .values({
            runId,
            cronId,
            schedulerTriggerId: input.schedulerTriggerId ?? null,
            manualRequestId: input.requestId ?? null,
            triggerSource: input.triggerSource,
            sessionId: null,
            status: 'pending',
            createdAtMs: input.createdAtMs,
            executionClaimedAtMs: null,
            deliveredAtMs: null,
            failedAtMs: null,
            errorCode: null,
            error: null,
        })
            .run();
        return this.require(runId);
    }
    require(runId) {
        const run = this.get(runId);
        if (!run)
            throw new CronRepositoryError('CRON_NOT_FOUND', 'Cron run not found');
        return run;
    }
}
function mapRun(value) {
    const row = value;
    const triggerSource = row.triggerSource;
    const status = row.status;
    if (triggerSource !== 'manual' && triggerSource !== 'scheduled') {
        throw new Error('Stored trigger is invalid');
    }
    if (status !== 'pending' && status !== 'delivered' && status !== 'failed') {
        throw new Error('Stored status is invalid');
    }
    return {
        runId: storedText(row.runId, 'runId'),
        cronId: storedText(row.cronId, 'cronId'),
        triggerSource,
        status,
        createdAtMs: storedTimestamp(row.createdAtMs, 'createdAtMs'),
        ...optionalRunFields(row),
        ...(row.deliveryInputJson ? { deliveryInput: parseDeliveryInput(row.deliveryInputJson) } : {}),
        ...(row.retryAtMs !== null ? { retryAtMs: storedTimestamp(row.retryAtMs, 'retryAtMs') } : {}),
        ...(row.retryAttempt > 0 ? { retryAttempt: row.retryAttempt } : {}),
    };
}
function optionalRunFields(row) {
    return {
        ...optionalRunIdentityFields(row),
        ...optionalRunClaimFields(row),
        ...optionalRunTerminalFields(row),
    };
}
function optionalRunIdentityFields(row) {
    const fields = {};
    if (row.schedulerTriggerId !== null) {
        fields.schedulerTriggerId = storedText(row.schedulerTriggerId, 'schedulerTriggerId');
    }
    if (row.manualRequestId !== null) {
        fields.requestId = storedText(row.manualRequestId, 'manualRequestId');
    }
    if (row.sessionId !== null)
        fields.sessionId = storedText(row.sessionId, 'sessionId');
    return fields;
}
function optionalRunClaimFields(row) {
    const fields = {};
    if (row.executionClaimedAtMs !== null) {
        fields.executionClaimedAtMs = storedTimestamp(row.executionClaimedAtMs, 'executionClaimedAtMs');
    }
    return fields;
}
function optionalRunTerminalFields(row) {
    const fields = {};
    if (row.deliveredAtMs !== null) {
        fields.deliveredAtMs = storedTimestamp(row.deliveredAtMs, 'deliveredAtMs');
    }
    if (row.failedAtMs !== null) {
        fields.failedAtMs = storedTimestamp(row.failedAtMs, 'failedAtMs');
    }
    if (row.errorCode !== null)
        fields.errorCode = storedText(row.errorCode, 'errorCode');
    if (row.error !== null) {
        if (typeof row.error !== 'string')
            throw new Error('Stored error is invalid');
        fields.error = row.error;
    }
    return fields;
}
function storedText(value, field) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`Stored ${field} is invalid`);
    }
    return value;
}
function storedTimestamp(value, field) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`Stored ${field} is invalid`);
    }
    return value;
}
function sameTerminal(run, status) {
    return run?.status === status;
}
const deliveryInputSchema = z.object({
    agentName: z.string().min(1),
    cronName: z.string().min(1),
    prompt: z.string().min(1),
    sessionTarget: z.discriminatedUnion('mode', [
        z.object({ mode: z.literal('new') }),
        z.object({ mode: z.literal('sessionId'), sessionId: z.string().optional() }),
    ]),
    model: z.string().nullable().optional(),
    project: z.string().nullable().optional(),
});
function parseDeliveryInput(json) {
    return deliveryInputSchema.parse(JSON.parse(json));
}
//# sourceMappingURL=run.repository.js.map