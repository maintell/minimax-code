import { isSelfReminderId } from '@mavis/shared/cron-purpose';
import { decodeCronModel, encodeCronModel } from '@mavis/shared/cron-model';
import { CronRepositoryError } from '../errors.js';
import { createSelfReminderService } from './self-reminder.js';
import { assertCronContentSafe } from './content-safety.js';
import { toCronSchedule } from './schedule.js';
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;
const RECONCILIATION_DRAIN_TIMEOUT_MS = 5_000;
async function settleBestEffort(operation) {
    try {
        await operation();
    }
    catch {
        // A detached reconciliation must never alter the already-committed Cron result.
    }
}
/**
 * Cron 的公开业务实现。它组合数据生命周期、仓储和通用 Scheduler 能力，
 * 只暴露不含 CAS 细节的稳定契约。
 */
export function createCronService(deps) {
    return new SchedulerBackedCronService(deps);
}
class SchedulerBackedCronService {
    deps;
    detachedReconciliations = new Set();
    closeController = new AbortController();
    closePromise;
    selfReminders;
    constructor(deps) {
        this.deps = deps;
        this.selfReminders = createSelfReminderService({
            ...deps,
            resolveModel: (model) => resolveDefinitionModel(model, deps.modelSelection),
        });
    }
    listDefinitions(query) {
        const limit = clampLimit(query.limit);
        const cursor = decodeDefinitionCursor(query.cursor, query);
        const rows = this.queryDefinitionPage(query, cursor, limit + 1);
        const page = paginate(rows, limit, (row) => encodeDefinitionCursor(row, query));
        const items = page.items.map((definition) => this.toDefinitionView(definition));
        return {
            items,
            hasMore: page.hasMore,
            ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        };
    }
    getDefinition(cronId) {
        const definition = this.deps.definitions.get(cronId, true);
        if (!definition)
            return undefined;
        return this.toDefinitionView(definition);
    }
    async createDefinition(command, context = { mutationSource: 'http_api' }) {
        this.assertOpen();
        const nowMs = this.deps.nowMs();
        const model = resolveDefinitionModel(command.model, this.deps.modelSelection);
        await assertCronContentSafe(this.deps.reviewContent, command);
        this.assertOpen();
        const created = this.deps.lifecycle.create({
            agentName: command.agentName,
            name: command.name,
            prompt: command.prompt,
            schedule: command.schedule,
            active: command.enabled ?? true,
            sessionTarget: command.sessionTarget,
            project: command.project,
            model,
            nowMs,
        });
        if (created.sessionTarget.mode === 'sessionId' && created.sessionTarget.sessionId) {
            this.trackDetached((signal) => syncSingleSessionTitle(this.deps.sessionCreation, created, signal));
        }
        const view = this.toDefinitionView(created);
        this.deps.metrics.taskCreated(view, context.mutationSource);
        return view;
    }
    async updateDefinition(command, context = { mutationSource: 'http_api' }) {
        this.assertOpen();
        const nowMs = this.deps.nowMs();
        const model = resolveDefinitionModel(command.model, this.deps.modelSelection);
        await assertCronContentSafe(this.deps.reviewContent, command);
        this.assertOpen();
        const updated = this.deps.lifecycle.update({
            cronId: command.cronId,
            ...(command.name === undefined ? {} : { name: command.name }),
            ...(command.schedule === undefined ? {} : { schedule: command.schedule }),
            ...(command.prompt === undefined ? {} : { prompt: command.prompt }),
            ...(command.sessionTarget === undefined ? {} : { sessionTarget: command.sessionTarget }),
            ...(command.enabled === undefined ? {} : { active: command.enabled }),
            ...(command.model === undefined ? {} : { model }),
            ...(command.project === undefined ? {} : { project: command.project }),
            nowMs,
        });
        if (command.name !== undefined) {
            this.trackDetached((signal) => syncSingleSessionTitle(this.deps.sessionCreation, updated, signal));
        }
        const view = this.toDefinitionView(updated);
        this.deps.metrics.taskUpdated(view, context.mutationSource);
        return view;
    }
    deleteDefinition(command, context = { mutationSource: 'http_api' }) {
        this.assertOpen();
        const definition = this.deps.definitions.get(command.cronId);
        const metricTask = definition ? this.toMetricTask(definition) : undefined;
        // Product deletion is retention-safe: tombstone the definition, cancel its
        // Scheduler job, and keep every Cron Run and conversation for history.
        this.deps.lifecycle.delete({
            cronId: command.cronId,
            nowMs: this.deps.nowMs(),
            deleteRuns: false,
        });
        if (metricTask)
            this.deps.metrics.taskDeleted(metricTask, context.mutationSource);
        return this.trackReconciliation((signal) => this.deps.sessionCreation.detach?.(command.cronId, definition?.sessionTarget.mode === 'sessionId'
            ? definition.sessionTarget.sessionId
            : undefined, signal) ?? Promise.resolve());
    }
    deleteDefinitionsByAgent(agentName) {
        this.assertOpen();
        const definitions = [];
        let before;
        do {
            const page = this.deps.definitions.listPage({
                agentName,
                take: MAX_PAGE_LIMIT,
                ...(before ? { before } : {}),
            });
            definitions.push(...page);
            const last = page.at(-1);
            before =
                page.length === MAX_PAGE_LIMIT && last
                    ? { createdAtMs: last.createdAtMs, cronId: last.cronId }
                    : undefined;
        } while (before);
        for (const definition of definitions) {
            const metricTask = this.toMetricTask(definition);
            this.deps.lifecycle.delete({
                cronId: definition.cronId,
                nowMs: this.deps.nowMs(),
                deleteRuns: false,
            });
            this.trackDetached((signal) => this.deps.sessionCreation.detach?.(definition.cronId, definition.sessionTarget.mode === 'sessionId'
                ? definition.sessionTarget.sessionId
                : undefined, signal));
            if (metricTask)
                this.deps.metrics.taskDeleted(metricTask, 'system');
        }
    }
    async triggerManualRun(cronId, context = { triggerSource: 'http_api' }) {
        this.assertOpen();
        const requestId = context.requestId;
        if (requestId !== undefined && !/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId)) {
            throw new CronRepositoryError('CRON_INVALID', 'requestId must be 1-128 ASCII identifier characters');
        }
        const definition = this.deps.definitions.get(cronId);
        if (!definition) {
            throw new CronRepositoryError('CRON_NOT_FOUND', 'Cron definition not found');
        }
        const metricTask = this.toMetricTask(definition);
        const prepared = await this.deps.executor.prepareManual({
            cronId,
            ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
            ...(metricTask ? { triggerMetric: { source: context.triggerSource, task: metricTask } } : {}),
        });
        return toRunView(prepared);
    }
    listRuns(query) {
        const limit = clampLimit(query.limit);
        const cursor = decodeRunCursor(query.cursor, query.cronId);
        const rows = this.queryRunPage(query.cronId, cursor, limit + 1);
        const page = paginate(rows, limit, (run) => encodeRunCursor(run, query.cronId));
        return {
            items: page.items.map(toRunView),
            hasMore: page.hasMore,
            ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        };
    }
    toDefinitionView(definition) {
        const job = requireSchedulerJob(this.deps.scheduler.inspect(definition.schedulerId));
        return this.composeView(definition, job);
    }
    composeView(definition, job) {
        return {
            cronId: definition.cronId,
            name: definition.name,
            agentName: definition.agentName,
            schedule: toCronSchedule(job.schedule),
            enabled: job.state === 'active',
            prompt: definition.prompt,
            sessionTarget: definition.sessionTarget,
            project: definition.project,
            model: definition.model,
            createdAtMs: definition.createdAtMs,
            updatedAtMs: definition.updatedAtMs,
            ...(job.nextRunAtMs === undefined ? {} : { nextRunAtMs: job.nextRunAtMs }),
            ...(definition.deletedAtMs === undefined ? {} : { deletedAtMs: definition.deletedAtMs }),
        };
    }
    toMetricTask(definition) {
        try {
            const job = this.deps.scheduler.inspect(definition.schedulerId);
            if (!job)
                return undefined;
            return {
                agentName: definition.agentName,
                schedule: toCronSchedule(job.schedule),
                sessionTarget: definition.sessionTarget,
            };
        }
        catch {
            return undefined;
        }
    }
    queryDefinitionPage(query, cursor, take) {
        return this.deps.definitions.listPage({
            ...(query.agentName === undefined ? {} : { agentName: query.agentName }),
            includeDeleted: query.includeDeleted === true,
            ...(cursor ? { before: { createdAtMs: cursor.createdAtMs, cronId: cursor.id } } : {}),
            take,
        });
    }
    queryRunPage(cronId, cursor, take) {
        return this.deps.runs.listPage({
            cronId,
            ...(cursor ? { before: { createdAtMs: cursor.createdAtMs, runId: cursor.id } } : {}),
            take,
        });
    }
    trackDetached(operation) {
        if (this.closeController.signal.aborted)
            return;
        this.trackSettlement(this.startReconciliation(operation));
    }
    trackReconciliation(operation) {
        const pending = this.startReconciliation(operation);
        this.trackSettlement(pending);
        return pending;
    }
    async startReconciliation(operation) {
        await Promise.resolve();
        this.closeController.signal.throwIfAborted();
        return operation(this.closeController.signal);
    }
    trackSettlement(pending) {
        // Observe failures for shutdown without hiding a required detach failure
        // from its request caller. Only unsettled work stays retained by the owner.
        const observe = async () => {
            await settleBestEffort(() => pending);
            this.detachedReconciliations.delete(observed);
        };
        const observed = observe();
        this.detachedReconciliations.add(observed);
    }
    assertOpen() {
        if (this.closeController.signal.aborted)
            throw new CronRepositoryError('CRON_INVALID_STATE', 'Cron service is closed');
    }
    close() {
        this.closeController.abort();
        this.closePromise ??= this.drainReconciliations();
        return this.closePromise;
    }
    async drainReconciliations() {
        if (this.detachedReconciliations.size === 0)
            return;
        let timer;
        try {
            await Promise.race([
                Promise.all([...this.detachedReconciliations]),
                new Promise((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error('Cron reconciliation drain timed out')), RECONCILIATION_DRAIN_TIMEOUT_MS);
                }),
            ]);
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }
}
function resolveDefinitionModel(model, selection) {
    if (model === undefined || model === null)
        return model;
    if (!model.trim())
        return null;
    let decoded;
    try {
        decoded = decodeCronModel(model);
    }
    catch {
        throw new CronRepositoryError('CRON_INVALID', 'Invalid scheduled task model configuration');
    }
    const resolution = selection.resolve(decoded.modelKey);
    if (resolution.kind === 'resolved') {
        if (!decoded.selection)
            return resolution.modelKey;
        const separator = resolution.modelKey.indexOf('/');
        return encodeCronModel({
            ...decoded.selection,
            providerID: resolution.modelKey.slice(0, separator),
            modelID: resolution.modelKey.slice(separator + 1),
        });
    }
    if (resolution.kind === 'ambiguous') {
        throw new CronRepositoryError('CRON_INVALID', `Model ${JSON.stringify(model)} matches multiple available models: ${resolution.candidates.join(', ')}. Ask the user to choose one.`);
    }
    throw new CronRepositoryError('CRON_INVALID', `Model ${JSON.stringify(model)} does not match an available model. Ask the user to choose one.`);
}
function syncSingleSessionTitle(sessionCreation, definition, signal) {
    if (isSelfReminderId(definition.cronId) || definition.sessionTarget.mode !== 'sessionId') {
        return Promise.resolve();
    }
    const sessionId = definition.sessionTarget.sessionId;
    if (!sessionId)
        return Promise.resolve();
    // The task definition is already durable. Session metadata is a separate
    // boundary, so title convergence follows the same best-effort rule as
    // task-owned session cleanup.
    return settleBestEffort(() => sessionCreation.rename?.(sessionId, definition.name, signal));
}
function paginate(rows, limit, toCursor) {
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return {
        items,
        hasMore,
        ...(hasMore && last ? { nextCursor: toCursor(last) } : {}),
    };
}
function clampLimit(limit) {
    if (limit === undefined)
        return DEFAULT_PAGE_LIMIT;
    if (!Number.isInteger(limit) || limit <= 0) {
        throw new CronRepositoryError('CRON_INVALID', 'limit must be a positive integer');
    }
    return Math.min(limit, MAX_PAGE_LIMIT);
}
function encodeDefinitionCursor(row, query) {
    return encodeCursor({
        version: 1,
        kind: 'definitions',
        scope: {
            agentName: query.agentName ?? null,
            includeDeleted: query.includeDeleted === true,
        },
        createdAtMs: row.createdAtMs,
        id: row.cronId,
    });
}
function decodeDefinitionCursor(cursor, query) {
    const decoded = decodeCursor(cursor);
    if (decoded === undefined)
        return undefined;
    if (decoded.kind !== 'definitions' ||
        decoded.scope.agentName !== (query.agentName ?? null) ||
        decoded.scope.includeDeleted !== (query.includeDeleted === true)) {
        throw new CronRepositoryError('CRON_INVALID', 'cursor does not match this definition query');
    }
    return { createdAtMs: decoded.createdAtMs, id: decoded.id };
}
function encodeRunCursor(run, cronId) {
    return encodeCursor({
        version: 1,
        kind: 'runs',
        scope: { cronId },
        createdAtMs: run.createdAtMs,
        id: run.runId,
    });
}
function decodeRunCursor(cursor, cronId) {
    const decoded = decodeCursor(cursor);
    if (decoded === undefined)
        return undefined;
    if (decoded.kind !== 'runs' || decoded.scope.cronId !== cronId) {
        throw new CronRepositoryError('CRON_INVALID', 'cursor does not match this run query');
    }
    return { createdAtMs: decoded.createdAtMs, id: decoded.id };
}
function encodeCursor(payload) {
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}
function decodeCursor(cursor) {
    if (cursor === undefined || cursor.trim() === '')
        return undefined;
    let value;
    try {
        value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    }
    catch {
        throw new CronRepositoryError('CRON_INVALID', 'cursor is malformed');
    }
    if (!isCursorPayload(value)) {
        throw new CronRepositoryError('CRON_INVALID', 'cursor is malformed');
    }
    return value;
}
function isCursorPayload(value) {
    if (!isCursorBase(value))
        return false;
    const payload = value;
    const scope = payload.scope;
    if (payload.kind === 'definitions')
        return isDefinitionCursorScope(scope);
    return payload.kind === 'runs' && isRunCursorScope(scope);
}
function isCursorBase(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const payload = value;
    const validTimestamp = Number.isSafeInteger(payload.createdAtMs) && payload.createdAtMs >= 0;
    const validId = typeof payload.id === 'string' && payload.id.length > 0;
    const validScope = typeof payload.scope === 'object' && payload.scope !== null;
    return payload.version === 1 && validTimestamp && validId && validScope;
}
function isDefinitionCursorScope(scope) {
    const validAgentName = scope.agentName === null || typeof scope.agentName === 'string';
    return validAgentName && typeof scope.includeDeleted === 'boolean';
}
function isRunCursorScope(scope) {
    return typeof scope.cronId === 'string' && scope.cronId.length > 0;
}
const RUN_VIEW_STATUS = {
    pending: 'pending',
    delivered: 'delivered',
    failed: 'failed',
};
const RUN_VIEW_SOURCE = {
    manual: 'manual',
    scheduled: 'scheduled',
};
function toRunView(run) {
    return {
        runId: run.runId,
        cronId: run.cronId,
        triggerSource: RUN_VIEW_SOURCE[run.triggerSource],
        status: RUN_VIEW_STATUS[run.status],
        createdAtMs: run.createdAtMs,
        ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
        ...(run.deliveredAtMs === undefined ? {} : { deliveredAtMs: run.deliveredAtMs }),
        ...(run.failedAtMs === undefined ? {} : { failedAtMs: run.failedAtMs }),
        ...(run.errorCode === undefined ? {} : { errorCode: run.errorCode }),
        ...(run.error === undefined ? {} : { error: run.error }),
    };
}
function requireSchedulerJob(job) {
    if (!job) {
        throw new CronRepositoryError('CRON_NOT_FOUND', 'Cron definition has no Scheduler job');
    }
    return job;
}
//# sourceMappingURL=cron.service.js.map