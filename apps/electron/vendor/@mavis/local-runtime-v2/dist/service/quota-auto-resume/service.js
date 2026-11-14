import { decideQuotaResetResume, isQuotaWindowRestored } from './reset-decision.js';
import { QUOTA_AUTO_RESUME_JITTER_MAX_MS, QUOTA_AUTO_RESUME_MAX_AUTO_RETRY, QUOTA_AUTO_RESUME_STALE_MS, quotaAutoResumeTurnKey as turnKey, } from './contracts.js';
const defaultTimers = {
    setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
    clearTimeout: (handle) => clearTimeout(handle),
};
/**
 * Continues an ordinary conversation Turn that ended on the product quota code
 * (42212) once the account's own 5h Token Plan window resets.
 *
 * The wait lives outside the Turn: nothing stays running for hours, and every
 * step that cannot be proven falls back to today's behaviour — the failed Turn
 * leaves the quota reminder above the input box, which offers to buy credits
 * rather than a Retry action. One `setTimeout` per plan, re-armed on startup
 * and on system wake, because a suspended process does not advance its timers.
 */
export class QuotaAutoResumeServiceImpl {
    ports;
    store;
    timers = new Map();
    /** Auto-resume Turns this process admitted, so their own limit can re-plan. */
    autoResumeTurns = new Map();
    /**
     * Continuations still being opened, by Session. The continued Turn can settle
     * before open() returns its id, so the count is carried by Session meanwhile.
     */
    openingResumes = new Map();
    firing = new Set();
    sessionEpochs = new Map();
    closed = false;
    constructor(ports, store) {
        this.ports = ports;
        this.store = store;
    }
    async noteTurnStarted(turn) {
        if (this.closed)
            return;
        // A Turn this service admitted is not the user taking over.
        if (this.autoResumeTurns.has(turnKey(turn)))
            return;
        this.bumpSessionEpoch(turn.sessionId);
        if (!this.store.get(turn.sessionId))
            return;
        await this.drop(turn.sessionId, 'user-took-over');
    }
    async settleTurn(settlement) {
        if (this.closed)
            return;
        const key = turnKey(settlement);
        let carried = this.autoResumeTurns.get(key)?.autoRetryCount;
        this.autoResumeTurns.delete(key);
        const opening = this.openingResumes.get(settlement.sessionId);
        if (carried === undefined && opening && opening.sourceTurnId !== settlement.turnId) {
            carried = opening.autoRetryCount;
            this.openingResumes.delete(settlement.sessionId);
        }
        if (settlement.status !== 'failed' || !settlement.quotaExceeded)
            return;
        await this.plan(settlement, carried);
    }
    async reconcile(reason) {
        if (this.closed || !this.ports.desktopHost)
            return;
        if (!this.ports.enabled()) {
            await this.applySetting(false);
            return;
        }
        const now = this.ports.nowMs();
        const restored = new Map();
        for (const plan of this.store.list()) {
            await this.reconcilePlan(plan, reason, now, restored);
        }
    }
    async reconcilePlan(plan, reason, now, restored) {
        if (plan.resumeAtMs > now) {
            if (reason === 'quota-reset' && (await this.readQuotaRestored(plan, restored))) {
                this.log('reconciled', {
                    reason,
                    action: 'retry-now',
                    session_id: plan.sessionId,
                    turn_id: plan.turnId,
                    resume_at_ms: plan.resumeAtMs,
                });
                await this.fire(plan.sessionId, { early: true });
                return;
            }
            this.arm(plan, reason);
            return;
        }
        if (now - plan.interruptedAtMs > QUOTA_AUTO_RESUME_STALE_MS) {
            await this.drop(plan.sessionId, 'stale-after-restart');
            return;
        }
        this.log('reconciled', {
            reason,
            action: 'retry-now',
            session_id: plan.sessionId,
            turn_id: plan.turnId,
            resume_at_ms: plan.resumeAtMs,
        });
        await this.fire(plan.sessionId);
    }
    readQuotaRestored(plan, restored) {
        // Sessions of one account share the quota: read it once per model.
        let read = restored.get(plan.modelName);
        if (!read) {
            read = this.quotaRestored(plan);
            restored.set(plan.modelName, read);
        }
        return read;
    }
    async applySetting(enabled) {
        if (enabled || this.closed)
            return;
        const dropped = this.store.list();
        for (const sessionId of [...this.timers.keys()])
            this.clearTimer(sessionId);
        for (const plan of dropped)
            this.bumpSessionEpoch(plan.sessionId);
        for (const sessionId of [...this.openingResumes.keys()])
            this.bumpSessionEpoch(sessionId);
        this.store.deleteAll();
        for (const plan of dropped)
            this.logDelete(plan, 'setting-disabled');
    }
    async forgetSession(sessionId, reason) {
        this.bumpSessionEpoch(sessionId);
        this.clearTimer(sessionId);
        const plan = this.store.get(sessionId);
        if (!plan)
            return;
        this.store.delete(sessionId);
        this.logDelete(plan, reason);
    }
    close() {
        this.closed = true;
        for (const sessionId of [...this.timers.keys()])
            this.clearTimer(sessionId);
        for (const sessionId of [...this.openingResumes.keys()]) {
            this.ports.continuation.cancelOpening?.(sessionId);
        }
        this.autoResumeTurns.clear();
        this.openingResumes.clear();
    }
    /** Records a plan for a quota-failed Turn, or explains why it cannot. */
    async plan(settlement, carriedAutoRetryCount) {
        const { sessionId, turnId } = settlement;
        const epoch = this.sessionEpoch(sessionId);
        const autoRetryCount = carriedAutoRetryCount === undefined ? 0 : carriedAutoRetryCount + 1;
        if (autoRetryCount >= QUOTA_AUTO_RESUME_MAX_AUTO_RETRY) {
            await this.forgetSession(sessionId, 'continuation-rejected');
            this.skip(sessionId, turnId, 'auto-retry-limit-reached');
            return;
        }
        const model = await this.checkPlanningConditions(sessionId, turnId);
        if (model === undefined)
            return;
        const decision = decideQuotaResetResume(await this.readQuota(sessionId, turnId, model.modelName));
        if (!this.isEpochActive(sessionId, epoch))
            return;
        if (decision.kind === 'skip') {
            this.skip(sessionId, turnId, decision.reason);
            return;
        }
        const now = this.ports.nowMs();
        const resetAtMs = now + decision.delaySeconds * 1000;
        // The spread is stored with the plan, so a restart keeps the same arrival.
        const jitterMs = arrivalJitterMs(this.ports.random ?? Math.random);
        const plan = {
            sessionId,
            turnId,
            resumeAtMs: resetAtMs + jitterMs,
            interruptedAtMs: now,
            autoRetryCount,
            modelName: model.modelName,
            updatedAtMs: now,
        };
        this.store.upsert(plan);
        this.log('planned', {
            session_id: sessionId,
            turn_id: turnId,
            reset_at_ms: resetAtMs,
            resume_at_ms: plan.resumeAtMs,
            jitter_ms: jitterMs,
            auto_retry_count: autoRetryCount,
            model_source: model.modelSource,
        });
        this.arm(plan, 'plan');
    }
    /** The planning conditions that do not need the account; the model ends the chain. */
    async checkPlanningConditions(sessionId, turnId) {
        if (!this.ports.enabled()) {
            this.skip(sessionId, turnId, 'setting-disabled');
            return undefined;
        }
        if (!this.ports.desktopHost) {
            this.skip(sessionId, turnId, 'not-desktop-host');
            return undefined;
        }
        const session = await this.read(() => this.ports.sessions.get(sessionId), undefined);
        if (!session) {
            this.skip(sessionId, turnId, 'session-missing');
            return undefined;
        }
        if (session.archived) {
            this.skip(sessionId, turnId, 'session-archived');
            return undefined;
        }
        if (session.parentSessionId) {
            this.skip(sessionId, turnId, 'not-root-session');
            return undefined;
        }
        if (await this.read(() => this.ports.goals.hasUnfinishedGoal(sessionId), true)) {
            this.skip(sessionId, turnId, 'goal-active');
            return undefined;
        }
        const modelName = session.modelName?.trim();
        if (!modelName || !this.ports.usesBuiltinAccountModel(modelName)) {
            // The model source says which rule answered, so a Session that resolved
            // to a BYOK model stays distinguishable from one with no model at all.
            this.skip(sessionId, turnId, 'byok-model', session.modelSource);
            return undefined;
        }
        if ((await this.read(() => this.ports.continuation.inspect(sessionId), 'unavailable')) !==
            'available') {
            this.skip(sessionId, turnId, 'history-unavailable');
            return undefined;
        }
        return { modelName, modelSource: session.modelSource };
    }
    arm(plan, reason) {
        this.clearTimer(plan.sessionId);
        const delayMs = Math.max(0, plan.resumeAtMs - this.ports.nowMs());
        const timers = this.ports.timers ?? defaultTimers;
        const handle = timers.setTimeout(() => {
            this.startFire(plan.sessionId);
        }, delayMs);
        handle.unref?.();
        this.timers.set(plan.sessionId, handle);
        this.log('timer_armed', {
            reason,
            session_id: plan.sessionId,
            turn_id: plan.turnId,
            resume_at_ms: plan.resumeAtMs,
            delay_ms: delayMs,
        });
    }
    /** Runs the arrival off the timer callback, which cannot await it. */
    startFire(sessionId) {
        queueMicrotask(() => void this.fire(sessionId));
    }
    /** The 5h window has room again before its reset, as a reset card leaves it. */
    async quotaRestored(plan) {
        return isQuotaWindowRestored(await this.readQuota(plan.sessionId, plan.turnId, plan.modelName, { bypassCache: true }));
    }
    async fire(sessionId, options) {
        if (this.closed || this.firing.has(sessionId))
            return;
        this.firing.add(sessionId);
        try {
            const plan = this.store.get(sessionId);
            if (!plan)
                return;
            // A suspended or re-set system clock can reach this timer early.
            if (options?.early !== true && plan.resumeAtMs - this.ports.nowMs() > 0) {
                this.arm(plan, 'clock-behind');
                return;
            }
            const epoch = this.sessionEpoch(sessionId);
            if (!(await this.guards(plan, epoch)))
                return;
            this.clearTimer(sessionId);
            this.store.delete(sessionId);
            this.logDelete(plan, 'fired');
            await this.openContinuation(plan, epoch);
        }
        catch (error) {
            this.logWarn('retry_failed', { session_id: sessionId, error: describe(error) });
        }
        finally {
            this.openingResumes.delete(sessionId);
            this.firing.delete(sessionId);
        }
    }
    async openContinuation(plan, epoch) {
        const { sessionId } = plan;
        this.openingResumes.set(sessionId, {
            autoRetryCount: plan.autoRetryCount,
            sourceTurnId: plan.turnId,
        });
        const opened = await this.ports.continuation.open(sessionId);
        // Settled already when the entry is gone; keeping it would never be cleared.
        const stillOpening = this.openingResumes.delete(sessionId);
        if (!opened.accepted) {
            this.logWarn('continuation_rejected', {
                session_id: sessionId,
                turn_id: plan.turnId,
                resume_at_ms: plan.resumeAtMs,
            });
            return;
        }
        if (!this.isEpochActive(sessionId, epoch))
            return;
        if (stillOpening) {
            this.autoResumeTurns.set(turnKey({ sessionId, turnId: opened.turnId }), {
                autoRetryCount: plan.autoRetryCount,
            });
        }
        this.log('retried', {
            session_id: sessionId,
            turn_id: opened.turnId,
            resume_at_ms: plan.resumeAtMs,
            auto_retry_count: plan.autoRetryCount,
        });
    }
    async guards(plan, epoch) {
        // The setting can be switched off after the timer was armed, and nothing
        // watches it; the plan is only retired here, when it would have run.
        if (!this.ports.enabled()) {
            await this.drop(plan.sessionId, 'setting-disabled');
            return false;
        }
        const session = await this.read(() => this.ports.sessions.get(plan.sessionId), undefined);
        if (!session || session.archived) {
            await this.drop(plan.sessionId, 'guard-session');
            return false;
        }
        // The model can change while the plan waits (a BYOK pick or an API key
        // source); a continuation on it would spend the user's own credits.
        if (session.modelName?.trim() !== plan.modelName ||
            !this.ports.usesBuiltinAccountModel(plan.modelName)) {
            await this.drop(plan.sessionId, 'guard-model');
            return false;
        }
        const latestTurnId = await this.read(() => this.ports.sessions.latestTurnId(plan.sessionId), undefined);
        if (latestTurnId !== undefined && latestTurnId !== plan.turnId) {
            await this.drop(plan.sessionId, 'guard-latest-turn');
            return false;
        }
        const state = await this.read(() => this.ports.continuation.inspect(plan.sessionId), 'unavailable');
        if (state !== 'available') {
            await this.drop(plan.sessionId, 'guard-history');
            return false;
        }
        return this.isPlanStillActive(plan, epoch);
    }
    sessionEpoch(sessionId) {
        return this.sessionEpochs.get(sessionId) ?? 0;
    }
    bumpSessionEpoch(sessionId) {
        this.sessionEpochs.set(sessionId, this.sessionEpoch(sessionId) + 1);
        if (this.openingResumes.has(sessionId)) {
            this.ports.continuation.cancelOpening?.(sessionId);
        }
    }
    isEpochActive(sessionId, epoch) {
        return !this.closed && this.ports.enabled() && this.sessionEpoch(sessionId) === epoch;
    }
    isPlanStillActive(plan, epoch) {
        return (this.isEpochActive(plan.sessionId, epoch) &&
            this.store.get(plan.sessionId)?.turnId === plan.turnId);
    }
    async drop(sessionId, reason) {
        await this.forgetSession(sessionId, reason);
    }
    clearTimer(sessionId) {
        const handle = this.timers.get(sessionId);
        if (handle === undefined)
            return;
        this.timers.delete(sessionId);
        (this.ports.timers ?? defaultTimers).clearTimeout(handle);
    }
    async readQuota(sessionId, turnId, modelName, options) {
        const result = await this.read(() => options ? this.ports.quota.read(modelName, options) : this.ports.quota.read(modelName), {
            status: 'unknown',
            reason: 'quota-request-unavailable',
        });
        if (result.status !== 'available') {
            this.logWarn('quota_unreadable', {
                session_id: sessionId,
                turn_id: turnId,
                status: result.status,
            });
        }
        return result;
    }
    /** Every dependency is read fail-safe: an unreadable answer never schedules a retry. */
    async read(load, fallback) {
        try {
            return await load();
        }
        catch (error) {
            this.logWarn('read_failed', { error: describe(error) });
            return fallback;
        }
    }
    skip(sessionId, turnId, reason, modelSource) {
        this.log('skipped', {
            session_id: sessionId,
            turn_id: turnId,
            reason,
            ...(modelSource ? { model_source: modelSource } : {}),
        });
    }
    logDelete(plan, reason) {
        this.log('plan_deleted', {
            session_id: plan.sessionId,
            turn_id: plan.turnId,
            resume_at_ms: plan.resumeAtMs,
            reason,
        });
    }
    log(event, fields) {
        try {
            this.ports.logger?.info({ event: `quota_auto_resume_${event}`, ...fields }, '[quota-auto-resume]');
        }
        catch {
            // Diagnostics must never change a Turn outcome or a plan.
        }
    }
    logWarn(event, fields) {
        try {
            this.ports.logger?.warn({ event: `quota_auto_resume_${event}`, ...fields }, '[quota-auto-resume]');
        }
        catch {
            // Diagnostics must never change a Turn outcome or a plan.
        }
    }
}
/**
 * The random spread that keeps one account's Sessions from continuing in the
 * same millisecond: they share a 5h window, so they all read the same reset.
 * A misbehaving source must never push an arrival outside the window.
 */
function arrivalJitterMs(random) {
    const drawn = random();
    if (!Number.isFinite(drawn) || drawn <= 0)
        return 0;
    return Math.min(Math.floor(drawn * QUOTA_AUTO_RESUME_JITTER_MAX_MS), QUOTA_AUTO_RESUME_JITTER_MAX_MS - 1);
}
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=service.js.map