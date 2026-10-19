import { and, asc, eq, gt, inArray, lte, ne, sql } from 'drizzle-orm';
import { sessionClioOutbox, sessionClioState } from '../../infra/db/schema/session-clio.js';
class SessionClioStateCorruptionError extends Error {
    identityKey;
    sessionId;
    name = 'SessionClioStateCorruptionError';
    constructor(identityKey, sessionId) {
        super(`Session Clio state is unreadable: ${identityKey}/${sessionId}`);
        this.identityKey = identityKey;
        this.sessionId = sessionId;
    }
}
/**
 * SQLite-backed Session Clio store.
 *
 * Every write is a single immediate transaction: a state advance and the steps
 * it produced land together, so a crash between them is impossible. Reads are
 * synchronous because better-sqlite3 is, which keeps "durable before the caller
 * continues" a property of the code rather than a promise-ordering accident.
 */
export class DrizzleSessionClioStore {
    options;
    constructor(options) {
        this.options = options;
    }
    read(identityKey, sessionId) {
        const row = this.options.db
            .select()
            .from(sessionClioState)
            .where(and(eq(sessionClioState.identityKey, identityKey), eq(sessionClioState.sessionId, sessionId)))
            .get();
        return row ? decodeStateRow(row) : undefined;
    }
    hasForeignIdentity(identityKey, sessionId) {
        const row = this.options.db
            .select({ identityKey: sessionClioState.identityKey })
            .from(sessionClioState)
            .where(and(eq(sessionClioState.sessionId, sessionId), ne(sessionClioState.identityKey, identityKey)))
            .limit(1)
            .get();
        return row !== undefined;
    }
    exclude(input) {
        this.options.db
            .insert(sessionClioState)
            .values({
            identityKey: input.identity.identityKey,
            sessionId: input.sessionId,
            trajectoryId: input.trajectoryId,
            captureOrigin: input.captureOrigin,
            bizId: input.identity.bizId,
            inputVersion: 0,
            eligibility: 'excluded',
            stateJson: '',
            deadlineMs: 0,
            sealedAtMs: 0,
            createdAtMs: input.nowMs,
            updatedAtMs: input.nowMs,
        })
            .onConflictDoNothing()
            .run();
    }
    commit(input) {
        const stateJson = JSON.stringify(input.state);
        const deadlineMs = this.options.deadlineMs(input.state) ?? 0;
        const sealedAtMs = input.state.seal?.sealed_at_ms ?? 0;
        this.options.db.transaction((tx) => {
            tx.insert(sessionClioState)
                .values({
                identityKey: input.identity.identityKey,
                sessionId: input.sessionId,
                trajectoryId: input.trajectoryId,
                captureOrigin: input.captureOrigin,
                bizId: input.identity.bizId,
                inputVersion: input.state.input_version,
                eligibility: 'enrolled',
                stateJson,
                deadlineMs,
                sealedAtMs,
                createdAtMs: input.nowMs,
                updatedAtMs: input.nowMs,
            })
                .onConflictDoUpdate({
                target: [sessionClioState.identityKey, sessionClioState.sessionId],
                set: { stateJson, deadlineMs, sealedAtMs, updatedAtMs: input.nowMs },
            })
                .run();
            for (const step of input.steps) {
                tx.insert(sessionClioOutbox)
                    .values({
                    identityKey: input.identity.identityKey,
                    sessionId: input.sessionId,
                    seq: step.seq,
                    trajectoryId: input.trajectoryId,
                    captureOrigin: input.captureOrigin,
                    bizId: input.identity.bizId,
                    inputVersion: input.state.input_version,
                    stepType: step.step_type,
                    clientProducedTs: step.client_produced_ts,
                    payloadJson: JSON.stringify(step.clio_payload),
                    createdAtMs: input.nowMs,
                    attempts: 0,
                    nextAttemptAtMs: 0,
                })
                    .onConflictDoNothing()
                    .run();
            }
        }, { behavior: 'immediate' });
    }
    /**
     * Enrolled, unsealed Sessions whose inactivity boundary is already past.
     *
     * An unreadable row is skipped rather than thrown: one corrupted Session must
     * not stop every other Session from sealing on time. The row stays on disk for
     * inspection and its own reads still surface the corruption.
     */
    listDue(nowMs, limit) {
        return this.options.db
            .select()
            .from(sessionClioState)
            .where(and(eq(sessionClioState.sealedAtMs, 0), gt(sessionClioState.deadlineMs, 0), lte(sessionClioState.deadlineMs, nowMs - 1)))
            .orderBy(asc(sessionClioState.deadlineMs))
            .limit(limit)
            .all()
            .flatMap((row) => {
            if (row.eligibility !== 'enrolled')
                return [];
            try {
                return [decodeStateRow(row)];
            }
            catch {
                return [];
            }
        });
    }
    /**
     * Due records, gated on sequence order within each Session.
     *
     * A record is claimable only while no earlier record of the same Session is
     * still waiting out a deferral (or sitting retired on the sentinel). Without
     * the gate, a seal produced while an earlier batch backs off would be
     * uploaded first; the server would freeze the Session and every deferred
     * record behind the hole would be permanently rejected on retry. Later
     * records park behind the blocker instead — they stay on disk, unclaimed,
     * until the earlier record is delivered or a migration resubmits them.
     */
    claimReady(input) {
        return this.options.db
            .select()
            .from(sessionClioOutbox)
            .where(and(eq(sessionClioOutbox.identityKey, input.identityKey), lte(sessionClioOutbox.nextAttemptAtMs, input.nowMs), sql `NOT EXISTS (
            SELECT 1 FROM ${sessionClioOutbox} AS blocker
            WHERE blocker.identity_key = ${sessionClioOutbox.identityKey}
              AND blocker.session_id = ${sessionClioOutbox.sessionId}
              AND blocker.seq < ${sessionClioOutbox.seq}
              AND blocker.next_attempt_at_ms > ${input.nowMs}
          )`))
            .orderBy(asc(sessionClioOutbox.sessionId), asc(sessionClioOutbox.seq))
            .limit(input.limit)
            .all()
            .map((row) => ({
            identityKey: row.identityKey,
            sessionId: row.sessionId,
            trajectoryId: row.trajectoryId,
            captureOrigin: row.captureOrigin,
            seq: row.seq,
            stepType: row.stepType,
            clientProducedTs: row.clientProducedTs,
            payloadJson: row.payloadJson,
            attempts: row.attempts,
        }));
    }
    deleteSent(input) {
        if (input.seqs.length === 0)
            return;
        this.options.db
            .delete(sessionClioOutbox)
            .where(and(eq(sessionClioOutbox.identityKey, input.identityKey), eq(sessionClioOutbox.sessionId, input.sessionId), inArray(sessionClioOutbox.seq, [...input.seqs])))
            .run();
    }
    deferSent(input) {
        if (input.seqs.length === 0)
            return;
        this.options.db
            .update(sessionClioOutbox)
            .set({
            attempts: sql `${sessionClioOutbox.attempts} + 1`,
            nextAttemptAtMs: input.nextAttemptAtMs,
            lastError: input.reason.slice(0, 500),
        })
            .where(and(eq(sessionClioOutbox.identityKey, input.identityKey), eq(sessionClioOutbox.sessionId, input.sessionId), inArray(sessionClioOutbox.seq, [...input.seqs])))
            .run();
    }
}
function decodeStateRow(row) {
    const base = {
        identityKey: row.identityKey,
        sessionId: row.sessionId,
        trajectoryId: row.trajectoryId,
        captureOrigin: row.captureOrigin,
        bizId: row.bizId,
    };
    if (row.eligibility === 'excluded') {
        return { ...base, eligibility: 'excluded', state: undefined };
    }
    return { ...base, eligibility: 'enrolled', state: decodeState(row) };
}
function decodeState(row) {
    let parsed;
    try {
        parsed = JSON.parse(row.stateJson);
    }
    catch {
        throw new SessionClioStateCorruptionError(row.identityKey, row.sessionId);
    }
    if (!isSessionClioState(parsed)) {
        throw new SessionClioStateCorruptionError(row.identityKey, row.sessionId);
    }
    return parsed;
}
function isSessionClioState(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const candidate = value;
    return (typeof candidate.input_version === 'number' &&
        typeof candidate.next_seq === 'number' &&
        Array.isArray(candidate.queries) &&
        Array.isArray(candidate.turns) &&
        typeof candidate.scope === 'object' &&
        candidate.scope !== null);
}
//# sourceMappingURL=store.js.map