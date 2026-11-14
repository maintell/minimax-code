import { randomUUID } from 'node:crypto';
import { incrementMetric } from '@mavis/shared/local-runtime-logging/metric-registry';
import { emergencyPayload, traceEmergency } from '../trace.js';
import { emergencyRebuild } from './rebuild.js';
import { EMERGENCY_REBUILD_REASON, EMERGENCY_RESEND_REASON, EmergencyTurn, } from './turn.js';
/** Product metric of the emergency handling (spec 12.3); labels are enums only. */
/**
 * Emergency rebuilds of every Bunny main conversation: one controller per
 * running Turn, the segment limit that outlives a restart (spec 3.5), and the
 * trace, diagnostics record and metric of each handling (spec 12).
 */
export class EmergencyRebuilds {
    host;
    turns = new Map();
    /** Store writes per Session, in order; a limit check waits for the writes before it. */
    writes = new Map();
    /** Turns settling per Session, owned so the detached work is awaited by `drained`. */
    settling = new Map();
    /** What each Turn's preparation already repaired: each repair is made once (3.1). */
    preparationRepairs = new WeakMap();
    /** Each Session's limit and identifier state (3.5, 9.1) as last read or written. */
    states = new Map();
    /** The identifier requests carry while a Session's state cannot be read (9.1). */
    unreadIdentifiers = new Map();
    store;
    constructor(host) {
        this.host = host;
        this.store = host.ports.emergency ?? createMemoryEmergencyStore();
    }
    get ports() {
        return this.host.ports;
    }
    now() {
        return this.ports.nowMs?.() ?? Date.now();
    }
    /** The controller of a Turn that starts; a previous one that never settled fails. */
    begin(sessionId, turnId) {
        const unsettled = this.turns.get(sessionId);
        if (unsettled)
            this.settle(sessionId, unsettled, { status: 'failed' });
        const turn = new EmergencyTurn({
            sessionId,
            turnId,
            nowMs: () => this.now(),
            classify: (failure) => this.ports.classifyFailure?.(failure),
            segmentLimitReached: () => this.segmentLimitReached(sessionId),
            turnSucceeded: () => this.markSucceeded(sessionId),
            report: (record) => this.report(sessionId, record),
        });
        this.turns.set(sessionId, turn);
        return turn;
    }
    /**
     * The Turn's preparation failed (spec 3.1): Bunny's corrupt built-in
     * configuration is rewritten (8.1), a corrupt history is repaired (6.2),
     * and the preparation is redone, so both get repaired when both are
     * corrupt. Any other failure, or one a repair this Turn already made did
     * not cure, fails the Turn as it does today. Never throws.
     */
    async repairPreparation(turn, error) {
        const done = this.preparationRepairs.get(turn.emergency) ?? new Set();
        this.preparationRepairs.set(turn.emergency, done);
        try {
            const config = done.has('config') ? undefined : await this.rewriteConfig(turn, error);
            if (config === 'repaired')
                done.add('config');
            if (config || done.has('history'))
                return config ?? 'not_handled';
            const history = await this.repairHistory(turn);
            if (history === 'repaired')
                done.add('history');
            return history;
        }
        catch {
            // A repair that throws leaves the failure as it was.
            return 'not_handled';
        }
    }
    /** Undefined when the failure is not Bunny's corrupt built-in configuration. */
    async rewriteConfig(turn, error) {
        const outcome = await this.ports.configRepair?.repair(error);
        if (!outcome || outcome.status === 'not_applicable')
            return undefined;
        if (outcome.status === 'repaired') {
            turn.emergency.configRewritten(outcome.backupFile);
            return 'repaired';
        }
        turn.emergency.configRewriteFailed();
        return 'not_handled';
    }
    async repairHistory(turn) {
        const outcome = await this.ports.historyRepair?.repair(turn.sessionId, {
            turnId: turn.turnId,
        });
        if (outcome?.status === 'repaired') {
            await turn.emergency.historyRepaired(outcome.repair);
            return 'repaired';
        }
        if (outcome?.status === 'failed')
            turn.emergency.historyRepairFailed();
        return 'not_handled';
    }
    /**
     * The first request after a history repair: the standard-level rebuild
     * over the repaired history (6.2). Undefined for any other request, and
     * when the rebuild cannot be made: the request goes on over the repaired
     * history, which the Turn already reads.
     */
    async afterRepair(turn, request, hooks) {
        if (!turn.emergency.pendingRebuild?.repair)
            return undefined;
        const outcome = await this.rebuild(turn, request, hooks);
        return outcome.kind === 'fail' && !request.signal?.aborted ? undefined : outcome;
    }
    /**
     * A request that repeats one this Turn's failure handling asked for:
     * unchanged (3.4), or over the segment the rebuild makes (4). Undefined
     * for a recovery that is not the emergency rebuild's.
     */
    async recover(turn, request, hooks) {
        const reason = request.recovery?.reason;
        if (reason === EMERGENCY_RESEND_REASON)
            return { kind: 'continue' };
        if (reason !== EMERGENCY_REBUILD_REASON)
            return undefined;
        return this.rebuild(turn, request, hooks);
    }
    rebuild(turn, request, hooks) {
        const log = {
            rebuildCommitting: (sessionId, from) => this.rebuildCommitting(sessionId, from),
            rebuildCommitted: (sessionId, segmentId) => this.rebuildCommitted(sessionId, segmentId),
            latestBackup: (sessionId) => this.latestBackup(sessionId),
        };
        return emergencyRebuild({ ...this.host, ...log }, { ...turn, request, hooks });
    }
    /** The Turn settled; never throws. */
    finish(sessionId, turn, settlement) {
        if (this.turns.get(sessionId) === turn)
            this.turns.delete(sessionId);
        this.settle(sessionId, turn, settlement);
    }
    /**
     * The session identifier the Session's model requests carry (spec 9.1),
     * read as each is sent: the one the last emergency rebuild chose, the
     * Session ID before the first. While the store cannot be read, a new one of
     * this process: the one a rebuild chose may be in it, and the Session ID may
     * be what that rebuild moved away from.
     */
    async providerSessionId(sessionId) {
        try {
            await this.state(sessionId);
        }
        catch {
            if (!this.unreadIdentifiers.has(sessionId)) {
                this.unreadIdentifiers.set(sessionId, randomUUID());
            }
        }
        return () => this.states.get(sessionId)?.providerSessionId ??
            this.unreadIdentifiers.get(sessionId) ??
            sessionId;
    }
    /** The Session's state; throws when the store cannot read it and this process knows none. */
    async state(sessionId) {
        if (!this.states.has(sessionId)) {
            await this.writes.get(sessionId);
            const stored = await this.resolveCommitting(sessionId, await this.store.readState(sessionId));
            if (!this.states.has(sessionId))
                this.states.set(sessionId, stored);
        }
        return this.states.get(sessionId);
    }
    /**
     * A stored state can still name a rebuild that was about to commit when the
     * state after its commit could not be written: once the segment it started
     * from is gone, that rebuild opened the current one.
     */
    async resolveCommitting(sessionId, stored) {
        const committing = stored?.committing;
        if (!stored || !committing)
            return stored;
        const { segmentId } = await this.ports.history.readSegment(sessionId);
        if (segmentId === committing.from)
            return settledState(stored);
        // A context reset's segment is under no limit (context reset spec 4.4).
        if (committing.reset)
            return { succeeded: true, providerSessionId: committing.providerSessionId };
        return {
            ...(segmentId ? { segmentId } : {}),
            succeeded: false,
            providerSessionId: committing.providerSessionId,
        };
    }
    /**
     * A user's context reset is about to replace the history over the segment
     * `from`: the new session identifier is written first, so a reset that
     * commits always leaves it in the store (context reset spec 4.6). A state
     * that cannot be read is replaced. Throws when it cannot be written: the
     * reset is not made (5.4).
     */
    async resetCommitting(sessionId, from) {
        let current;
        try {
            current = await this.state(sessionId);
        }
        catch {
            current = undefined;
        }
        const next = {
            ...settledState(current ?? { succeeded: true }),
            committing: { from, providerSessionId: randomUUID(), reset: true },
        };
        await this.enqueueOrThrow(sessionId, () => this.store.writeState(sessionId, next));
        this.states.set(sessionId, next);
    }
    /**
     * The context reset committed: requests carry its session identifier from
     * the next one on, and its segment has no limit, so a later failure may be
     * rebuilt at once (context reset spec 4.4, 4.6). A failed write leaves the
     * state written before the commit, which resolves the same way.
     */
    resetCommitted(sessionId) {
        const state = {
            succeeded: true,
            providerSessionId: this.states.get(sessionId)?.committing?.providerSessionId ?? randomUUID(),
        };
        this.states.set(sessionId, state);
        this.unreadIdentifiers.delete(sessionId);
        return this.enqueue(sessionId, () => this.store.writeState(sessionId, state));
    }
    /** The context reset did not commit: the next read resolves the stored state against the history. */
    resetAbandoned(sessionId) {
        this.states.delete(sessionId);
    }
    /**
     * An emergency rebuild is about to commit over the segment `from`: its new
     * session identifier and the segment limit are written first, so a commit
     * always leaves them in the store (3.5, 9.1). Throws when they cannot be
     * written or the state cannot be read: the rebuild is not made (3.7).
     */
    async rebuildCommitting(sessionId, from) {
        const current = await this.state(sessionId);
        const next = {
            ...settledState(current ?? { succeeded: false }),
            committing: { from, providerSessionId: randomUUID() },
        };
        const previous = this.writes.get(sessionId);
        let failure;
        const write = (async () => {
            await previous;
            try {
                await this.store.writeState(sessionId, next);
            }
            catch (error) {
                failure = { error };
            }
        })();
        this.writes.set(sessionId, write);
        await write;
        if (failure)
            throw failure.error;
        this.states.set(sessionId, next);
    }
    /**
     * The emergency rebuild committed: model requests carry its new session
     * identifier from the next one on (9.1), and `segmentId`, the segment it
     * opened, has no Turn succeeded yet (3.5). A failed write leaves the state
     * written before the commit, which names this rebuild.
     */
    rebuildCommitted(sessionId, segmentId) {
        const state = {
            ...(segmentId ? { segmentId } : {}),
            succeeded: false,
            providerSessionId: this.states.get(sessionId)?.committing?.providerSessionId ?? randomUUID(),
        };
        this.states.set(sessionId, state);
        this.unreadIdentifiers.delete(sessionId);
        return this.enqueue(sessionId, () => this.store.writeState(sessionId, state));
    }
    /** Waits for the Session's store writes (tests and diagnostics). */
    async drained(sessionId) {
        await this.settling.get(sessionId);
        await this.writes.get(sessionId);
    }
    /** The newest history snapshot: the backup the rebuild's commit just wrote (spec 10.1). */
    async latestBackup(sessionId) {
        try {
            return await this.store.latestBackup(sessionId);
        }
        catch {
            return undefined;
        }
    }
    async segmentLimitReached(sessionId) {
        try {
            const state = await this.state(sessionId);
            if (!state?.segmentId || state.succeeded)
                return false;
            return (await this.ports.history.readSegment(sessionId)).segmentId === state.segmentId;
        }
        catch {
            // A limit that cannot be read holds (3.5): the Turn fails as it does today.
            return true;
        }
    }
    /**
     * A Turn of the segment succeeded (3.5). A failed write leaves the limit in
     * the store, so after a restart it holds until another Turn succeeds.
     */
    async markSucceeded(sessionId) {
        let state;
        try {
            state = await this.state(sessionId);
        }
        catch {
            return;
        }
        if (!state || (state.succeeded && !state.committing))
            return;
        // A rebuild that was about to commit and did not is no longer pending.
        const succeeded = { ...settledState(state), succeeded: true };
        this.states.set(sessionId, succeeded);
        await this.enqueue(sessionId, () => this.store.writeState(sessionId, succeeded));
    }
    report(sessionId, record) {
        const payload = emergencyPayload(sessionId, record.turnId, {
            action: record.action,
            category: record.category,
            level: record.level,
            result: record.result,
            ...(record.failureReason ? { failureReason: record.failureReason } : {}),
            ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode }),
            replacedCounts: record.replaced,
            affinityRotated: record.affinityRotated,
            ...(record.backupFile ? { backupFile: record.backupFile } : {}),
            durationMs: record.durationMs,
        });
        traceEmergency(this.ports.trace, sessionId, record.turnId, payload);
        const recordedAtMs = this.now();
        this.writes.set(sessionId, writeAfter(this.writes.get(sessionId), () => this.store.appendRecord(sessionId, { recorded_at_ms: recordedAtMs, ...payload })));
        // Metrics never change the Turn: incrementMetric never throws.
        incrementMetric(this.ports.metrics, 'bunny_emergency_rebuild_total', 1, {
            category: record.category,
            action: record.action,
            level: record.level,
            result: record.result,
        });
    }
    /** Settles a Turn's controller after the ones before it; never throws. */
    settle(sessionId, turn, settlement) {
        this.settling.set(sessionId, settleAfter(this.settling.get(sessionId), turn, settlement));
    }
    /** A store write after the ones before it; its own failure is thrown. */
    async enqueueOrThrow(sessionId, write) {
        const previous = this.writes.get(sessionId);
        let failure;
        const next = (async () => {
            await previous;
            try {
                await write();
            }
            catch (error) {
                failure = { error };
            }
        })();
        this.writes.set(sessionId, next);
        await next;
        if (failure)
            throw failure.error;
    }
    enqueue(sessionId, write) {
        const next = writeAfter(this.writes.get(sessionId), write);
        this.writes.set(sessionId, next);
        return next;
    }
}
/** A state without the rebuild it names as about to commit. */
function settledState(state) {
    return {
        ...(state.segmentId ? { segmentId: state.segmentId } : {}),
        succeeded: state.succeeded,
        ...(state.providerSessionId ? { providerSessionId: state.providerSessionId } : {}),
    };
}
/** Settles a Turn's controller; its trace and records are best effort. */
async function settleAfter(previous, turn, settlement) {
    await previous;
    try {
        await turn.finish(settlement);
    }
    catch {
        // Diagnostics never change the Turn.
    }
}
/**
 * One store write after the ones before it; a failed write is dropped. Only
 * the writes after a Turn's outcome go this way: a diagnostics record, and a
 * state the one written before the commit already covers.
 */
async function writeAfter(previous, write) {
    await previous;
    try {
        await write();
    }
    catch {
        // The Turn's outcome is already decided.
    }
}
/** Process memory only: the limits hold until the application restarts. */
function createMemoryEmergencyStore() {
    const states = new Map();
    return {
        readState: async (sessionId) => states.get(sessionId),
        writeState: async (sessionId, state) => {
            states.set(sessionId, state);
        },
        appendRecord: async () => undefined,
        latestBackup: async () => undefined,
    };
}
//# sourceMappingURL=session.js.map