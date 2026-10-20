import { checkConsolidationWindow } from './consolidation-window.js';
import { GLOBAL_SCOPE_KEY } from '../contracts.js';
import { computeOutputDigest, renderRulesMirror, renderSessionMirror } from './session-doc.js';
export class MemoryReconciler {
    deps;
    admitting = false;
    wakeRequested = false;
    pendingWakeIds = [];
    pendingBoundary;
    drainResolve;
    drainPromise;
    running = false;
    runPromise;
    /** 整理、非会话级失败与抽取环境故障的进程内退避；其余抽取失败走持久记账（§6.1）。 */
    retryAfter = new Map();
    /** 模型限流后的下一次可运行时刻；到期本身不产生唤醒（§10）。 */
    modelBlockedUntilMs = 0;
    constructor(deps) {
        this.deps = deps;
    }
    /** ready() 只开放准入：不扫描、不建定时器，唤醒只来自 kick（§5.10）。 */
    async ready() {
        this.admitting = true;
        this.event('reconciler.ready', {});
    }
    kick(signal) {
        const wakeId = this.deps.diagnostics?.event('reconciler.wake', {
            signal,
            admitted: this.admitting,
            coalesced: this.wakeRequested,
        });
        if (!this.admitting)
            return;
        if (wakeId)
            this.pendingWakeIds.push(wakeId);
        if (signal.kind === 'task-start' || signal.kind === 'manual-capture') {
            if (this.pendingBoundary) {
                this.pendingBoundary.createdBeforeMs = Math.min(this.pendingBoundary.createdBeforeMs, signal.createdBeforeMs);
                if (signal.kind === 'task-start')
                    this.pendingBoundary.excludeSessionIds.add(signal.triggerSessionId);
            }
            else {
                this.pendingBoundary = {
                    createdBeforeMs: signal.createdBeforeMs,
                    excludeSessionIds: new Set(signal.kind === 'task-start' ? [signal.triggerSessionId] : []),
                };
            }
        }
        this.wakeRequested = true;
        this.scheduleRun();
    }
    stopAdmission() {
        this.admitting = false;
        this.event('reconciler.stop-admission', {});
    }
    async drain(signal) {
        if (!this.running && !this.wakeRequested)
            return;
        if (signal.aborted)
            return;
        if (this.drainPromise) {
            await this.drainPromise;
            return;
        }
        this.drainPromise = new Promise((resolve) => {
            this.drainResolve = resolve;
        });
        const onAbort = () => {
            this.drainResolve?.();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        await this.drainPromise;
        signal.removeEventListener('abort', onAbort);
        this.drainPromise = undefined;
        this.drainResolve = undefined;
    }
    scheduleRun() {
        if (this.running)
            return;
        this.running = true;
        this.runPromise = this.runLoopWithRelease();
    }
    /** 用 try/finally 而非 Promise.finally：仓库规则要求 async/await 形态。 */
    async runLoopWithRelease() {
        try {
            await this.runLoop();
        }
        finally {
            this.running = false;
            if (this.drainResolve && !this.wakeRequested) {
                this.drainResolve();
            }
        }
    }
    async runLoop() {
        while (this.wakeRequested) {
            this.wakeRequested = false;
            // 正在执行的一轮冻结自己的边界，后到信号归下一轮(§5.10)。
            const boundary = this.pendingBoundary;
            const wakeIds = this.pendingWakeIds;
            this.pendingBoundary = undefined;
            this.pendingWakeIds = [];
            try {
                if (this.deps.diagnostics)
                    await this.deps.diagnostics.run('reconciler.round', { wakeIds, boundary, config: this.deps.config() }, () => this.runOneRound(boundary), true);
                else
                    await this.runOneRound(boundary);
            }
            catch (error) {
                this.reportFailure(error);
            }
        }
    }
    /** One round: the fixed sequence from §5.10. */
    async runOneRound(boundary) {
        const config = this.deps.config();
        if (!config.writeEnabled) {
            this.event('reconciler.skipped', { reason: 'generation-disabled' });
            return;
        }
        // Step 1: 读取本轮状态侧工作集。
        const work = await this.deps.repository.listReconciliationWork(this.deps.nowMs());
        // Step 2: 清理临时文件、孤儿目录，并把镜像补物化到与 DB 一致(§6.4)。
        await this.cleanupOrphanScopeDirs();
        await this.maintainFiles(work, config);
        // Step 3/4: 按阶段实际通道检查额度；后续每项新任务再次准入，在途任务继续完成。
        const capturedScopeKeys = new Set();
        if (boundary && (await this.modelTasksAllowed('capture', config))) {
            await this.captureCandidates(config, boundary, capturedScopeKeys);
        }
        // Step 5: 整理独立准入，允许 capture 与 consolidation 使用不同通道。
        if (await this.modelTasksAllowed('consolidation', config)) {
            await this.consolidateScopes(work, capturedScopeKeys);
        }
        // Step 6: Apply retention
        await this.deps.governance.applyRetention({
            nowMs: this.deps.nowMs(),
            retentionDays: config.retentionDays,
            limit: 100,
        });
        // Step 7: Retry Reset file cleanup
        await this.cleanupResetFiles(work);
        // Step 8 由 runLoop 检查执行期间收到的新 wake。
    }
    async modelTasksAllowed(kind, config) {
        if (!this.modelSchedulingAllowed(kind, config))
            return false;
        try {
            const quota = await this.deps.model.readQuota(kind);
            const allowed = quota.status !== 'available' ||
                ![quota.fiveHour, quota.weekly].some((remaining) => typeof remaining === 'number' && remaining < config.minModelQuotaRemainingPercent);
            this.event('model.quota', {
                kind,
                quota,
                minimumPercent: config.minModelQuotaRemainingPercent,
                allowed,
            });
            if (!allowed) {
                this.event('model.skipped', { kind, reason: 'subscription-quota-low' });
                return false;
            }
        }
        catch {
            this.event('model.quota', { kind, reason: 'quota-unavailable', allowed: true });
        }
        return true;
    }
    modelSchedulingAllowed(kind, config) {
        if (kind === 'consolidation') {
            const window = checkConsolidationWindow(config.consolidationCron, this.deps.nowMs());
            if (window !== 'allowed') {
                this.event('model.skipped', { kind, reason: `consolidation-${window}` });
                return false;
            }
        }
        if (this.deps.nowMs() < this.modelBlockedUntilMs) {
            this.event('model.skipped', {
                kind,
                reason: 'model-backoff',
                retryAtMs: this.modelBlockedUntilMs,
            });
            return false;
        }
        return true;
    }
    /** `scopes/` 层级下非 global 的目录都是孤儿，直接删除(§6.4)。 */
    async cleanupOrphanScopeDirs() {
        try {
            const dirs = await this.deps.fileStore.listScopeDirs();
            for (const dir of dirs) {
                if (dir === GLOBAL_SCOPE_KEY)
                    continue;
                await this.deps.fileStore.deleteScopeDir(dir);
            }
        }
        catch (error) {
            this.reportFailure(error);
        }
    }
    async maintainFiles(work, config) {
        for (const scopeKey of work.activeScopes) {
            await this.deps.scopeMutation.withScopeMutation(scopeKey, async () => {
                await this.deps.fileStore.cleanupTemps(scopeKey);
                await this.cleanupSessionFiles(scopeKey);
                await this.rematerializeMirrors(scopeKey, config);
            });
        }
    }
    /** 删除没有状态行或来源会话已删除的镜像；来源删除同时清状态行。 */
    async cleanupSessionFiles(scopeKey) {
        const files = await this.deps.fileStore.listSessionMemoryFiles(scopeKey);
        for (const sessionId of files) {
            const state = await this.deps.repository.getSessionState(scopeKey, sessionId);
            if (!state) {
                await this.deps.fileStore.deleteSessionMemory(scopeKey, sessionId);
                await this.deps.fileStore.deleteSessionRules(scopeKey, sessionId);
            }
            else if (
            // legacy-* 与 note-*（§5.18 变更单）没有来源会话，不做存在性检查。
            !sessionId.startsWith('legacy-') &&
                !sessionId.startsWith('note-') &&
                (await this.deps.source.readContext(sessionId)).status === 'not-found') {
                await this.deps.repository.deleteSessionState({ scopeKey, sessionId });
                await this.deps.fileStore.deleteSessionMemory(scopeKey, sessionId);
                await this.deps.fileStore.deleteSessionRules(scopeKey, sessionId);
            }
        }
    }
    /** 镜像缺失或与 output_digest 不符时从 DB 免模型重物化(§6.4)。 */
    async rematerializeMirrors(scopeKey, config) {
        const scope = await this.deps.repository.getScope(scopeKey);
        if (!scope)
            return;
        const states = await this.deps.repository.selectCurrentSessions({
            scopeKey,
            createdAfterMs: scope.resetAtMs,
            maxSessions: config.maxSelectedSessions,
        });
        const notes = await this.deps.repository.listAdHocNotes(scopeKey);
        const noteNames = new Set(notes.map((note) => `${note.sessionId}.md`));
        for (const filename of await this.deps.fileStore.listAdHocNoteFiles(scopeKey)) {
            if (!noteNames.has(filename))
                await this.deps.fileStore.deleteAdHocNoteMirror(scopeKey, filename);
        }
        for (const note of notes) {
            const mirror = renderSessionMirror(note, note.content ?? '');
            if ((await this.deps.fileStore.readAdHocNoteMirror(scopeKey, `${note.sessionId}.md`)) !== mirror) {
                await this.deps.fileStore.writeAdHocNoteMirror(scopeKey, `${note.sessionId}.md`, mirror);
            }
            // 新位置完整写入后才移除旧投影，DB 文档始终保持不变。
            await this.deps.fileStore.deleteSessionMemory(scopeKey, note.sessionId);
            await this.deps.fileStore.deleteSessionRules(scopeKey, note.sessionId);
        }
        for (const state of states) {
            await this.rematerializeOne(scopeKey, state);
        }
    }
    async rematerializeOne(scopeKey, state) {
        if (state.content !== undefined) {
            const expected = renderSessionMirror({
                sessionId: state.sessionId,
                sourceRevision: state.sourceRevision,
                sourceDigest: state.sourceDigest,
                capturedAtMs: state.capturedAtMs,
                agentName: state.agentName,
                projectName: state.projectName,
                workspaceDir: state.workspaceDir,
            }, state.content);
            if (computeOutputDigest(expected) === state.outputDigest) {
                const current = await this.deps.fileStore.readSessionMemory(scopeKey, state.sessionId);
                if (current !== expected) {
                    await this.deps.fileStore.writeSessionMemory(scopeKey, state.sessionId, expected);
                }
            }
        }
        if (state.forgetRules !== undefined) {
            const expectedRules = renderRulesMirror({
                sessionId: state.sessionId,
                updatedAtMs: state.updatedAtMs,
                rules: state.forgetRules,
            });
            const currentRules = await this.deps.fileStore.readSessionRules(scopeKey, state.sessionId);
            if (currentRules !== expectedRules) {
                await this.deps.fileStore.writeSessionRules(scopeKey, state.sessionId, expectedRules);
            }
        }
    }
    async inspectCaptures(createdBeforeMs, inspect) {
        const config = this.deps.config();
        const attempts = await this.loadAttempts();
        const captures = [];
        for await (const candidate of this.candidates(config, {
            createdBeforeMs,
            excludeSessionIds: new Set(),
        })) {
            const attempt = attempts.get(candidate.sessionId);
            captures.push({
                ...candidate,
                inspection: attempt && this.isBackedOff(attempts, candidate, config)
                    ? { status: 'backoff', attempt }
                    : await inspect(candidate),
            });
        }
        return captures;
    }
    async *candidates(config, boundary) {
        let cursor;
        do {
            const page = await this.deps.source.listCaptureCandidates({
                createdBeforeMs: boundary.createdBeforeMs,
                excludeSessionIds: [...boundary.excludeSessionIds],
                idleForMs: config.eligibleSessionIdleMs,
                maxAgeDays: config.eligibleSessionMaxAgeDays,
                limit: 50,
                cursor,
            });
            yield* page.candidates;
            cursor = page.nextCursor;
        } while (cursor);
    }
    async captureCandidates(config, boundary, capturedScopeKeys) {
        const attempts = await this.loadAttempts();
        const candidates = this.candidates(config, boundary);
        const seen = new Set();
        const inFlight = new Map();
        let modelCaptures = 0;
        const runCandidate = async (candidate) => {
            try {
                if (await this.captureCandidate(candidate, config, capturedScopeKeys))
                    modelCaptures += 1;
            }
            catch (error) {
                modelCaptures += 1;
                this.reportFailure(error);
                await this.recordFailure(candidate, 'store-unavailable', config);
            }
            finally {
                inFlight.delete(candidate.sessionId);
            }
        };
        try {
            while (modelCaptures < config.maxCaptureSessionsPerWake) {
                if (this.deps.nowMs() < this.modelBlockedUntilMs)
                    break;
                // 在途 Capture 先占一个模型额度；无模型的返回释放额度后再继续领取。
                if (inFlight.size >= config.maxCaptureConcurrency ||
                    modelCaptures + inFlight.size >= config.maxCaptureSessionsPerWake) {
                    await Promise.race(inFlight.values());
                    continue;
                }
                const next = await candidates.next();
                if (next.done)
                    break;
                const candidate = next.value;
                if (seen.has(candidate.sessionId))
                    continue;
                seen.add(candidate.sessionId);
                if (this.isBackedOff(attempts, candidate, config)) {
                    this.event('capture.skipped', {
                        candidate,
                        reason: 'capture-backoff-or-exhausted',
                        attempt: attempts.get(candidate.sessionId),
                    });
                    continue;
                }
                // Recheck synchronously at dispatch after quota I/O and queued continuations.
                if (!(await this.modelTasksAllowed('capture', this.deps.config())) ||
                    !this.modelSchedulingAllowed('capture', this.deps.config())) {
                    break;
                }
                inFlight.set(candidate.sessionId, runCandidate(candidate));
            }
        }
        finally {
            // 候选分页或单个任务失败时，也必须等待已启动的全部任务结束。
            await Promise.allSettled(inFlight.values());
            await candidates.return(undefined);
        }
        this.event('capture.batch-stopped', {
            modelCaptures,
            maximum: config.maxCaptureSessionsPerWake,
            concurrency: config.maxCaptureConcurrency,
            modelBlockedUntilMs: this.modelBlockedUntilMs,
        });
    }
    async loadAttempts() {
        const rows = await this.deps.repository.listCaptureAttempts(GLOBAL_SCOPE_KEY);
        return new Map(rows.map((row) => [row.sessionId, row]));
    }
    /** 失败记账过滤：退避期内跳过；同 revision 耗尽转 retry-exhausted 终态(§2.3)。 */
    isBackedOff(attempts, candidate, config) {
        if ((this.retryAfter.get(captureHoldKey(candidate)) ?? 0) > this.deps.nowMs())
            return true;
        const attempt = attempts.get(candidate.sessionId);
        if (!attempt)
            return false;
        if (attempt.sourceRevision !== candidate.sourceRevision)
            return false;
        // 旧版本把环境故障也记入次数；最后一次失败是环境故障的历史行不判耗尽，让会话恢复抽取。
        if (attempt.attempts >= config.maxCaptureAttemptsPerRevision &&
            countsTowardCaptureAttempts(attempt.lastReason)) {
            return true;
        }
        return attempt.retryAtMs > this.deps.nowMs();
    }
    /** 返回本次是否消耗了模型抽取额度。 */
    async captureCandidate(candidate, config, capturedScopeKeys) {
        const result = await this.deps.capture.capture(candidate);
        switch (result.status) {
            case 'unchanged':
            case 'ineligible':
                return false;
            case 'stale-input':
                return true;
            case 'deferred': {
                if (countsTowardCaptureAttempts(result.reason)) {
                    await this.recordFailure(candidate, result.reason, config);
                    return true;
                }
                // 环境故障与会话内容无关：停止本批模型任务，不消耗该会话的重试次数；
                // 进程内会话退避避免同一会话在后续唤醒中反复占住队首(§10)。
                this.modelBlockedUntilMs = this.deps.nowMs() + 60_000;
                const retryAtMs = this.deps.nowMs() + config.captureFailureBackoffMs;
                this.holdUntil(captureHoldKey(candidate), retryAtMs);
                this.event('capture.held', { candidate, reason: result.reason, retryAtMs });
                return true;
            }
            case 'updated':
                capturedScopeKeys.add(GLOBAL_SCOPE_KEY);
                return true;
        }
    }
    async recordFailure(candidate, reason, config) {
        try {
            await this.deps.repository.recordCaptureFailure({
                scopeKey: GLOBAL_SCOPE_KEY,
                sessionId: candidate.sessionId,
                sourceRevision: candidate.sourceRevision,
                reason,
                retryAtMs: this.deps.nowMs() + config.captureFailureBackoffMs,
                nowMs: this.deps.nowMs(),
            });
        }
        catch (error) {
            this.reportFailure(error);
        }
    }
    async consolidateScopes(work, capturedScopeKeys) {
        // 治理产生的待整理绕过成功冷却；常规刷新受冷却约束(§5.6)。
        const governanceScopes = new Set(work.scopesNeedingGovernance);
        const scopes = new Set([...work.activeScopes, ...governanceScopes, ...capturedScopeKeys]);
        for (const scopeKey of scopes) {
            const key = `scope:${scopeKey}`;
            if ((this.retryAfter.get(key) ?? 0) > this.deps.nowMs()) {
                this.event('consolidation.skipped', {
                    scopeKey,
                    reason: 'retry-backoff',
                    retryAtMs: this.retryAfter.get(key),
                });
                continue;
            }
            // Recheck synchronously at dispatch after quota I/O and queued continuations.
            if (!(await this.modelTasksAllowed('consolidation', this.deps.config())) ||
                !this.modelSchedulingAllowed('consolidation', this.deps.config())) {
                break;
            }
            try {
                const result = await this.deps.consolidation.rebuild(scopeKey, {
                    reason: governanceScopes.has(scopeKey) ? 'governance' : 'routine',
                });
                if (result.status === 'deferred')
                    this.defer(key, result.reason);
            }
            catch (error) {
                this.defer(key, error);
            }
        }
    }
    async cleanupResetFiles(work) {
        for (const scopeKey of work.scopesNeedingFileCleanup) {
            try {
                await this.deps.scopeMutation.withScopeMutation(scopeKey, async () => {
                    const scope = await this.deps.repository.getScope(scopeKey);
                    if (!scope || scope.resetAtMs === 0 || scope.consolidatedDigest !== undefined)
                        return;
                    const sessions = await this.deps.repository.selectCurrentSessions({
                        scopeKey,
                        createdAfterMs: scope.resetAtMs,
                        maxSessions: 1,
                    });
                    if (sessions.length === 0)
                        await this.deps.fileStore.deleteScopeFiles(scopeKey);
                });
            }
            catch {
                // 下轮继续重试。
            }
        }
    }
    defer(key, error) {
        this.holdUntil(key, this.deps.nowMs() + 60_000);
        this.reportFailure(error);
    }
    /** 登记进程内退避；按插入顺序淘汰最旧条目，长时间运行也不会无界增长。 */
    holdUntil(key, retryAtMs) {
        this.retryAfter.delete(key);
        this.retryAfter.set(key, retryAtMs);
        if (this.retryAfter.size > 4096) {
            const oldest = this.retryAfter.keys().next().value;
            if (oldest !== undefined)
                this.retryAfter.delete(oldest);
        }
    }
    event(event, payload) {
        this.deps.diagnostics?.event(event, payload);
    }
    reportFailure(error) {
        this.event('reconciler.failed', { error });
        try {
            this.deps.reportFailure?.(error);
        }
        catch {
            /* 上报失败不影响后台恢复。 */
        }
    }
}
/** 只有可归因于会话本身的失败计入重试次数；环境故障换个时间重发就可能成功(§10)。 */
function countsTowardCaptureAttempts(reason) {
    return reason !== 'model-unavailable';
}
/** 环境故障的会话退避键；绑定 revision，会话更新后立即重新入场。 */
function captureHoldKey(candidate) {
    return `capture:${candidate.sessionId}:${candidate.sourceRevision}`;
}
//# sourceMappingURL=reconciler.js.map