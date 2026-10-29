import { createHash } from 'node:crypto';
import { isSelfReminderId } from '@mavis/shared/cron-purpose';
const SESSION_CREATE_FAILED = 'SESSION_CREATE_FAILED';
const SESSION_DELIVERY_FAILED = 'SESSION_DELIVERY_FAILED';
const CRON_DEFINITION_DELETED = 'CRON_DEFINITION_DELETED';
const PROCESS_RESTARTED = 'PROCESS_RESTARTED';
const SESSION_CREATE_ERROR = 'Cron session creation failed';
const SESSION_DELIVERY_ERROR = 'Cron session delivery failed';
const CRON_DEFINITION_DELETED_ERROR = 'Cron definition was deleted before execution';
const PROCESS_RESTARTED_ERROR = 'Cron run abandoned by a previous process';
const MAX_BOUNDARY_ERROR_LENGTH = 256;
const MIN_REQUEST_TEXT_FRAGMENT_LENGTH = 24;
const TARGET_SESSION_FAILURE_MESSAGES = {
    CRON_SESSION_TARGET_NOT_FOUND: 'Cron target session was not found',
    CRON_SESSION_TARGET_ARCHIVED: 'Cron target session is archived',
    CRON_SESSION_TARGET_AGENT_MISMATCH: 'Cron target session belongs to a different agent',
    CRON_SESSION_TARGET_PROJECT_MISMATCH: 'Cron target session belongs to a different project',
};
class CronExecutionError extends Error {
    code;
    name = 'CronExecutionError';
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
/**
 * 调度回调与手动触发共享的唯一 Cron 执行循环。
 *
 * Scheduler 回调只持久化一条 pending 运行并快速返回；执行循环异步解析会话并投递轮次。
 * 所有终态迁移都经过 CronRun 仓储的比较并交换（CAS），使重复触发、进程重启和
 * 并发清空队列最终收敛到同一权威事实。
 */
export class CronExecutor {
    deps;
    inFlight = new Map();
    queue = [];
    pumpTail = Promise.resolve();
    pumpScheduled = false;
    closed = false;
    retryTimers = new Map();
    constructor(deps) {
        this.deps = deps;
    }
    /**
     * 兼容调用方的脱离请求链路手动触发入口。同步检查 requestId 所有权，冲突会
     * 向调用方抛错；接纳后的后台执行结果记录在持久化 CronRun 终态中。
     * 当前 HTTP 控制器使用 prepareManual，先取得持久化的 pending 运行再返回。
     */
    kickManual(request) {
        this.assertOpen();
        const existing = this.existingManualRun(request);
        if (existing) {
            this.enqueue(existing.runId, request.triggerMetric);
            return;
        }
        try {
            // All triggers commit admission synchronously and use the same pump.
            // A second detached manual tail could admit new work after close drained.
            const pending = this.resolveManualRun(request);
            this.enqueue(pending.runId, request.triggerMetric);
        }
        catch (error) {
            if (error instanceof CronExecutionError && error.code === 'CRON_RUN_ID_CONFLICT') {
                throw error;
            }
            // Preserve the compatibility entry's best-effort creation contract.
            // Product callers use prepareManual and observe creation failures.
        }
    }
    /**
     * 固定会话已归档时，触发在写入运行记录之前就被拦下：归档的对话收不到投递，
     * 留下一条必然失败的记录只会堆积在历史里。查询失败按未归档处理，交给执行时的会话校验。
     */
    async isTargetArchived(definition) {
        const target = definition.sessionTarget;
        if (target.mode !== 'sessionId' || !target.sessionId)
            return false;
        try {
            return (await this.deps.sessionCreation.isTargetArchived?.(target.sessionId)) === true;
        }
        catch {
            return false;
        }
    }
    /**
     * Scheduler 回调入口。在 Cron 事务中持久化 pending 调度运行，已有记录时则收敛到
     * 同一记录，随后加入队列；该入口不等待会话工作。
     */
    acceptScheduledTrigger(envelope) {
        if (this.closed)
            return { accepted: false, errorCode: 'CRON_EXECUTOR_CLOSED' };
        try {
            const run = this.deps.db.transaction(() => {
                const definition = this.deps.definitions.getBySchedulerId(envelope.schedulerId);
                if (!definition)
                    return undefined;
                return this.deps.runs.insertPendingScheduled(definition.cronId, envelope.triggerId, this.deps.nowMs());
            }, { behavior: 'immediate' });
            if (!run)
                return { accepted: false, errorCode: 'CRON_NOT_FOUND' };
            this.enqueue(run.runId, envelope.triggerMetric);
            return { accepted: true };
        }
        catch {
            return { accepted: false, errorCode: 'CRON_PERSIST_FAILED' };
        }
    }
    /**
     * 手动触发的产品入口：创建 pending 运行并等待会话关联，随后让投递继续在后台执行。
     * 调用方拿到的运行已具备可导航的 sessionId，运行终态仍由同一执行循环持久化。
     */
    async prepareManual(request) {
        this.assertOpen();
        const pending = this.resolveManualRun(request);
        return pending.status === 'pending'
            ? this.prepareSingleflight(pending, request.triggerMetric)
            : pending;
    }
    /** 执行一次手动投递；暂时拒绝时返回 pending，后续由持久化重试推进。 */
    async runManual(request) {
        this.assertOpen();
        const pending = this.resolveManualRun(request);
        return this.executeSingleflight(pending, request.triggerMetric);
    }
    /** 最多执行一条已入队运行；队列为空时返回 undefined。 */
    async drainOnce() {
        const queued = this.queue.shift();
        if (queued === undefined)
            return undefined;
        const current = this.deps.runs.get(queued.runId);
        if (!current)
            return undefined;
        if (current.status !== 'pending') {
            if (queued.triggerMetric) {
                this.deps.metrics.taskTriggered(queued.triggerMetric.task, queued.triggerMetric.source, 'skipped');
            }
            return current;
        }
        return this.executeSingleflight(current, queued.triggerMetric);
    }
    /** 持续处理直至队列清空，并按处理顺序返回所有终态运行。 */
    async drainAll() {
        const outcomes = [];
        for (;;) {
            const outcome = await this.drainOnce();
            if (!outcome)
                break;
            outcomes.push(outcome);
        }
        return outcomes;
    }
    /** 等待脱离请求链路的队列和所有已领取执行完成。 */
    async waitForIdle() {
        const outcomes = await Promise.allSettled([
            this.pumpTail,
            ...[...this.inFlight.values()].map((execution) => execution.completion),
        ]);
        const failed = outcomes.find((outcome) => outcome.status === 'rejected');
        if (failed?.status === 'rejected')
            throw failed.reason;
    }
    assertOpen() {
        if (this.closed) {
            throw new CronExecutionError('CRON_EXECUTOR_CLOSED', 'Cron executor is closed');
        }
    }
    /** 停止接收队列工作，并等待当前已领取运行写入数据库终态。 */
    async close() {
        this.closed = true;
        this.queue.splice(0);
        for (const timer of this.retryTimers.values())
            clearTimeout(timer);
        this.retryTimers.clear();
        await this.waitForIdle();
    }
    /**
     * 启动时恢复上一进程遗留的运行：
     * - 尚未领取的 pending 运行重新进入执行队列；
     * - 已持久化投递快照的运行复用 session/run 身份恢复，由 Turn 回执去重；
     * - 旧版本没有快照的已领取运行仍收敛为 failed(PROCESS_RESTARTED)。
     */
    async recoverPendingRuns() {
        this.assertOpen();
        const pending = this.listPendingRuns();
        const outcomes = [];
        for (const run of pending) {
            // Startup recovery runs after the runtime is ready; a run this process
            // is executing is not one a previous process abandoned.
            if (this.inFlight.has(run.runId))
                continue;
            if (run.executionClaimedAtMs === undefined || (run.deliveryInput && run.sessionId)) {
                this.enqueue(run.runId);
                continue;
            }
            const failedAtMs = this.deps.nowMs();
            const marked = this.deps.runs.markFailed({
                runId: run.runId,
                failedAtMs,
                errorCode: PROCESS_RESTARTED,
                error: PROCESS_RESTARTED_ERROR,
            });
            if (!marked) {
                this.warn(run, 'recovery-failed', 'failed');
            }
            const resolved = this.deps.runs.get(run.runId);
            if (resolved)
                outcomes.push(resolved);
        }
        const drained = await this.drainAll();
        // 覆盖离线期间过期的单次提醒和旧版本遗留的已结束提醒。
        retireBestEffort(() => this.deps.lifecycle.retireFinishedSelfReminders(this.deps.nowMs()));
        return [...outcomes, ...drained];
    }
    enqueue(runId, triggerMetric) {
        if (this.closed)
            return;
        if (!this.queue.some((queued) => queued.runId === runId)) {
            this.queue.push({ runId, ...(triggerMetric ? { triggerMetric } : {}) });
        }
        this.schedulePump();
    }
    schedulePump() {
        if (this.pumpScheduled || this.closed)
            return;
        this.pumpScheduled = true;
        this.pumpTail = this.continuePump(this.pumpTail);
    }
    async continuePump(previous) {
        try {
            await previous;
        }
        catch {
            // 前一轮错误只返回给对应等待者，后续队列仍可继续处理。
        }
        try {
            while (!this.closed) {
                const outcome = await this.drainOnce();
                if (!outcome)
                    break;
            }
        }
        finally {
            this.pumpScheduled = false;
            if (!this.closed && this.queue.length > 0)
                this.schedulePump();
        }
    }
    existingManualRun(request) {
        const existing = this.findManualRun(request);
        if (!existing)
            return undefined;
        this.assertManualOwnership(request.cronId, existing);
        return existing;
    }
    resolveManualRun(request) {
        const existing = this.existingManualRun(request);
        if (existing)
            return existing;
        try {
            return this.createManualRun(request);
        }
        catch (error) {
            const raced = this.resolveRacedManualRun(request);
            if (raced)
                return raced;
            throw normalizeCreateManualError(error);
        }
    }
    assertManualOwnership(cronId, run) {
        if (run.cronId !== cronId || run.triggerSource !== 'manual') {
            throw new CronExecutionError('CRON_RUN_ID_CONFLICT', 'Cron runId belongs to a different definition or trigger source');
        }
    }
    createManualRun(request) {
        return this.deps.db.transaction(() => {
            if (request.requestId) {
                const existing = this.deps.runs.getByManualRequestId(request.requestId);
                if (existing) {
                    this.assertManualOwnership(request.cronId, existing);
                    return existing;
                }
                return this.deps.lifecycle.createManualRun(request.cronId, this.deps.nowMs(), request.requestId);
            }
            if (request.runId) {
                const existing = this.findManualRun(request);
                if (existing) {
                    this.assertManualOwnership(request.cronId, existing);
                    return existing;
                }
                // Legacy direct callers supplied a stable runId. Store it as the
                // manual idempotency key while the repository keeps ownership of
                // the Run identifier.
                return this.deps.lifecycle.createManualRun(request.cronId, this.deps.nowMs(), request.runId);
            }
            return this.deps.lifecycle.createManualRun(request.cronId, this.deps.nowMs());
        }, { behavior: 'immediate' });
    }
    resolveRacedManualRun(request) {
        const raced = this.findManualRun(request);
        if (!raced)
            return undefined;
        this.assertManualOwnership(request.cronId, raced);
        return raced;
    }
    findManualRun(request) {
        if (request.requestId) {
            return (this.deps.runs.getByManualRequestId(request.requestId) ??
                this.deps.runs.get(`manual-request:${createHash('sha256').update(request.requestId).digest('hex')}`));
        }
        if (!request.runId)
            return undefined;
        return this.deps.runs.get(request.runId) ?? this.deps.runs.getByManualRequestId(request.runId);
    }
    executeSingleflight(pending, triggerMetric) {
        return this.getOrStartExecution(pending, triggerMetric).completion;
    }
    async prepareSingleflight(pending, triggerMetric) {
        const result = await this.getOrStartExecution(pending, triggerMetric).ready;
        if (result.kind === 'ready')
            return result.run;
        throw result.error;
    }
    getOrStartExecution(pending, triggerMetric) {
        const active = this.inFlight.get(pending.runId);
        if (active)
            return active;
        let settleReady = () => undefined;
        const ready = new Promise((resolve) => {
            settleReady = resolve;
        });
        const completion = this.executeDeferred(pending, settleReady, triggerMetric);
        const execution = {
            ready,
            completion,
            // 手动产品入口只等待 ready；预先观察后台执行的拒绝，完整结果仍由
            // runManual、队列泵和 waitForIdle 读取 completion。
            observedCompletion: observeCompletion(completion),
        };
        this.inFlight.set(pending.runId, execution);
        return execution;
    }
    async executeDeferred(pending, settleReady, triggerMetric) {
        await Promise.resolve();
        try {
            const outcome = await this.executePending(pending, settleReady, triggerMetric);
            this.retireAfterSelfReminderRun(outcome);
            return outcome;
        }
        catch (error) {
            settleReady({ kind: 'error', error });
            throw error;
        }
        finally {
            this.inFlight.delete(pending.runId);
        }
    }
    async executePending(pending, settleReady, triggerMetric) {
        if (pending.status !== 'pending')
            return settlePrepared(settleReady, pending);
        if (pending.retryAtMs !== undefined && pending.retryAtMs > this.deps.nowMs()) {
            this.scheduleRetry(pending);
            return settlePrepared(settleReady, pending);
        }
        const claimed = pending.deliveryInput && pending.sessionId
            ? pending
            : this.deps.runs.claimExecution(pending.runId, this.deps.nowMs());
        if (!claimed) {
            if (triggerMetric) {
                this.deps.metrics.taskTriggered(triggerMetric.task, triggerMetric.source, 'skipped');
            }
            return settlePrepared(settleReady, this.requireRun(pending.runId));
        }
        return this.executeClaimed(claimed, settleReady, triggerMetric);
    }
    async executeClaimed(claimed, settleReady, triggerMetric) {
        const startedAtMs = Date.now();
        let agentName = 'unknown';
        let outcome;
        try {
            const executionInput = claimed.deliveryInput ?? currentExecutionInput(this.deps.definitions.get(claimed.cronId));
            if (!executionInput) {
                outcome = settlePrepared(settleReady, this.finishFailed(claimed, CRON_DEFINITION_DELETED, CRON_DEFINITION_DELETED_ERROR, ''));
                return outcome;
            }
            agentName = executionInput.agentName;
            let sessionId;
            try {
                sessionId =
                    claimed.sessionId ?? (await this.createExecutionSession(claimed, executionInput));
            }
            catch (error) {
                const failure = targetSessionFailure(error);
                outcome = settlePrepared(settleReady, this.finishFailed(claimed, failure.code, failure.message, ''));
                return outcome;
            }
            if (!this.deps.runs.attachSession(claimed.runId, sessionId, executionInput)) {
                outcome = settlePrepared(settleReady, this.resolveConflict(claimed, 'session-attach-conflict', 'pending'));
                return outcome;
            }
            settleReady({ kind: 'ready', run: this.requireRun(claimed.runId) });
            outcome = await this.deliverClaimed(executionInput, claimed, sessionId);
            return outcome;
        }
        finally {
            this.reportExecutionMetrics(agentName, outcome, startedAtMs, triggerMetric);
        }
    }
    async deliverClaimed(input, run, sessionId) {
        const delivery = await this.deliver(input, run, sessionId);
        if (!delivery.delivered) {
            if (delivery.retryable)
                return this.deferDelivery(run);
            return this.finishFailed(run, delivery.errorCode, delivery.error, input.prompt);
        }
        if (!this.deps.runs.markDelivered(run.runId, this.deps.nowMs())) {
            return this.resolveConflict(run, 'terminal-conflict', 'delivered');
        }
        return this.requireRun(run.runId);
    }
    deferDelivery(run) {
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(run.retryAttempt ?? 0, 5));
        if (!this.deps.runs.deferDelivery(run.runId, this.deps.nowMs() + delay)) {
            return this.resolveConflict(run, 'terminal-conflict', 'pending');
        }
        const deferred = this.requireRun(run.runId);
        this.scheduleRetry(deferred);
        return deferred;
    }
    async createExecutionSession(claimed, executionInput) {
        const created = await this.deps.sessionCreation.create({
            agentName: executionInput.agentName,
            cronId: claimed.cronId,
            cronName: executionInput.cronName,
            runId: claimed.runId,
            runCreatedAtMs: claimed.createdAtMs,
            sessionTarget: executionInput.sessionTarget,
            project: executionInput.project,
            model: executionInput.model,
        });
        const sessionId = requireSessionId(created.sessionId);
        const pendingFixedTarget = executionInput.sessionTarget.mode === 'sessionId' && !executionInput.sessionTarget.sessionId;
        if (!pendingFixedTarget)
            return sessionId;
        return this.bindPendingFixedSession(claimed.cronId, sessionId);
    }
    async bindPendingFixedSession(cronId, createdSessionId) {
        let bound;
        try {
            bound = this.deps.definitions.bindPendingTargetSession(cronId, createdSessionId, this.deps.nowMs());
        }
        catch (error) {
            await discardSessionBestEffort(this.deps.sessionCreation, createdSessionId);
            throw error;
        }
        if (bound.sessionTarget.mode !== 'sessionId' || !bound.sessionTarget.sessionId) {
            throw new Error('Cron fixed session binding did not produce a target session');
        }
        const boundSessionId = bound.sessionTarget.sessionId;
        if (boundSessionId !== createdSessionId) {
            await discardSessionBestEffort(this.deps.sessionCreation, createdSessionId);
        }
        return boundSessionId;
    }
    reportExecutionMetrics(agentName, outcome, startedAtMs, triggerMetric) {
        const result = executionMetricResult(outcome);
        this.deps.metrics.taskExecuted(agentName, result, Date.now() - startedAtMs);
        if (result === 'failure') {
            this.deps.metrics.taskFailed(agentName, outcome?.errorCode ?? 'UNKNOWN');
        }
        if (!triggerMetric)
            return;
        this.deps.metrics.taskTriggered(triggerMetric.task, triggerMetric.source, triggerMetricOutcome(outcome));
    }
    scheduleRetry(run) {
        if (this.closed || this.retryTimers.has(run.runId))
            return;
        const delay = Math.max(1, (run.retryAtMs ?? this.deps.nowMs()) - this.deps.nowMs());
        const timer = setTimeout(() => {
            this.retryTimers.delete(run.runId);
            this.enqueue(run.runId);
        }, Math.min(delay, 30_000));
        timer.unref();
        this.retryTimers.set(run.runId, timer);
    }
    /** 自提醒运行落终态后，软删同会话已结束的提醒。 */
    retireAfterSelfReminderRun(run) {
        if (!isSelfReminderId(run.cronId) || run.status === 'pending')
            return;
        retireBestEffort(() => {
            const target = this.deps.definitions.get(run.cronId)?.sessionTarget;
            if (target?.mode !== 'sessionId' || !target.sessionId)
                return;
            this.deps.lifecycle.retireFinishedSelfReminders(this.deps.nowMs(), target.sessionId);
        });
    }
    async deliver(executionInput, pending, sessionId) {
        try {
            return await this.deps.delivery.deliver({
                cronId: pending.cronId,
                runId: pending.runId,
                sessionId,
                agentName: executionInput.agentName,
                cronName: executionInput.cronName,
                text: executionInput.prompt,
                ...(executionInput.model === undefined ? {} : { model: executionInput.model }),
                beforeDelivery: async () => {
                    if (!this.deps.definitions.get(pending.cronId)) {
                        throw new CronExecutionError(CRON_DEFINITION_DELETED, CRON_DEFINITION_DELETED_ERROR);
                    }
                },
            });
        }
        catch (error) {
            if (error instanceof CronExecutionError) {
                return { delivered: false, errorCode: error.code, error: error.message };
            }
            return {
                delivered: false,
                errorCode: SESSION_DELIVERY_FAILED,
                error: SESSION_DELIVERY_ERROR,
            };
        }
    }
    finishFailed(pending, errorCode, error, requestText) {
        const failedAtMs = this.deps.nowMs();
        const sanitizedCode = sanitizeErrorCode(errorCode, requestText) ?? SESSION_DELIVERY_FAILED;
        const sanitizedError = sanitizeBoundaryError(error, requestText);
        const marked = this.deps.runs.markFailed({
            runId: pending.runId,
            failedAtMs,
            errorCode: sanitizedCode,
            ...(sanitizedError ? { error: sanitizedError } : {}),
        });
        if (!marked)
            return this.resolveConflict(pending, 'terminal-conflict', 'failed');
        return this.requireRun(pending.runId);
    }
    resolveConflict(pending, event, requestedStatus) {
        const current = this.deps.runs.get(pending.runId);
        this.warnContext(pending, current?.status ?? 'missing', event, requestedStatus);
        if (current)
            return current;
        throw new CronExecutionError('CRON_RUN_FACT_MISSING', 'Cron run fact is missing');
    }
    warn(run, event, requestedStatus) {
        this.warnContext(run, run.status, event, requestedStatus);
    }
    warnContext(run, currentStatus, event, requestedStatus) {
        try {
            this.deps.logger.warn({
                component: 'cron-executor',
                event,
                cronId: run.cronId,
                runId: run.runId,
                currentStatus,
                requestedStatus,
            }, 'Cron run conflict preserved the existing fact');
        }
        catch {
            // 可观测性逻辑严禁改变 Cron 运行的权威结果。
        }
    }
    requireRun(runId) {
        const current = this.deps.runs.get(runId);
        if (current)
            return current;
        throw new CronExecutionError('CRON_RUN_FACT_MISSING', 'Cron run fact is missing');
    }
    listPendingRuns() {
        return this.deps.runs.listPending();
    }
}
async function discardSessionBestEffort(sessionCreation, sessionId) {
    try {
        await sessionCreation.discard?.(sessionId);
    }
    catch {
        // The durable fixed-session winner remains authoritative even if orphan cleanup fails.
    }
}
function retireBestEffort(retire) {
    try {
        retire();
    }
    catch {
        // 软删只影响列表展示；失败不改变 Run 终态，下一次运行或启动清扫会重试。
    }
}
function normalizeCreateManualError(error) {
    if (isCronNotFound(error)) {
        return new CronExecutionError('CRON_DEFINITION_NOT_FOUND', 'Cron definition was not found for manual execution');
    }
    return error;
}
function currentExecutionInput(definition) {
    if (!definition)
        return undefined;
    return {
        agentName: definition.agentName,
        cronName: definition.name,
        prompt: definition.prompt,
        sessionTarget: definition.sessionTarget,
        ...(definition.project === undefined ? {} : { project: definition.project }),
        ...(definition.model === undefined ? {} : { model: definition.model }),
    };
}
function settlePrepared(settleReady, run) {
    settleReady({ kind: 'ready', run });
    return run;
}
async function observeCompletion(completion) {
    try {
        await completion;
    }
    catch {
        // The persisted CronRun terminal state remains authoritative for background failures.
    }
}
function isCronNotFound(error) {
    return (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'CRON_NOT_FOUND');
}
function targetSessionFailure(error) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
        const code = error.code;
        if (typeof code === 'string' && code in TARGET_SESSION_FAILURE_MESSAGES) {
            const stableCode = code;
            return { code: stableCode, message: TARGET_SESSION_FAILURE_MESSAGES[stableCode] };
        }
    }
    return { code: SESSION_CREATE_FAILED, message: SESSION_CREATE_ERROR };
}
function requireSessionId(value) {
    if (typeof value !== 'string')
        throw new TypeError('Cron session creation returned no sessionId');
    const sessionId = value.trim();
    if (sessionId.length === 0 || sessionId !== value) {
        throw new TypeError('Cron session creation returned an invalid sessionId');
    }
    return sessionId;
}
function executionMetricResult(run) {
    if (run?.status === 'delivered')
        return 'success';
    if (run?.status === 'pending')
        return 'skipped';
    return 'failure';
}
function triggerMetricOutcome(run) {
    if (run?.status === 'delivered')
        return 'executed';
    if (run?.status === 'pending')
        return 'skipped';
    return 'error';
}
function sanitizeErrorCode(value, requestText) {
    if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value))
        return undefined;
    if (containsRequestText(value, requestText) ||
        containsRequestText(value.replaceAll('_', ' '), requestText)) {
        return undefined;
    }
    return value;
}
function sanitizeBoundaryError(value, requestText) {
    if (typeof value !== 'string')
        return undefined;
    const compact = compactBoundaryText(value);
    if (compact.length === 0)
        return undefined;
    if (containsSensitiveErrorData(compact) || containsRequestText(compact, requestText)) {
        return SESSION_DELIVERY_ERROR;
    }
    return compact.slice(0, MAX_BOUNDARY_ERROR_LENGTH);
}
function compactBoundaryText(value) {
    return value
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
function containsRequestText(error, requestText) {
    const request = compactBoundaryText(requestText);
    if (request.length === 0)
        return false;
    const normalizedError = error.toLowerCase();
    const normalizedRequest = request.toLowerCase();
    if (normalizedError.includes(normalizedRequest))
        return true;
    if (normalizedError.length < MIN_REQUEST_TEXT_FRAGMENT_LENGTH ||
        normalizedRequest.length < MIN_REQUEST_TEXT_FRAGMENT_LENGTH) {
        return false;
    }
    for (let start = 0; start <= normalizedError.length - MIN_REQUEST_TEXT_FRAGMENT_LENGTH; start += 1) {
        const fragment = normalizedError.slice(start, start + MIN_REQUEST_TEXT_FRAGMENT_LENGTH);
        if (normalizedRequest.includes(fragment))
            return true;
    }
    return false;
}
function containsSensitiveErrorData(value) {
    return (/\b(?:authorization|bearer|credential|password|prompt|secret|token|api[_-]?key)\b\s*[:=]/i.test(value) ||
        /\bBearer\s+[A-Za-z0-9._~+/=-]+/i.test(value) ||
        /\bsk-[A-Za-z0-9_-]{8,}\b/.test(value) ||
        /\bfile:\/\/\S+/i.test(value) ||
        /(?:^|\s|\()(?:\/(?:Users|home|private|tmp|var|etc)\/|[A-Za-z]:\\)/.test(value) ||
        /\s+at\s+[^\s]+\s+\([^)]*:\d+:\d+\)/.test(value));
}
//# sourceMappingURL=executor.js.map