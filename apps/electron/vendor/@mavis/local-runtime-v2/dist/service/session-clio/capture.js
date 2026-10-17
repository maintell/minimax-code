import { KeyedOperationLane } from '@mavis/shared/keyed-operation-lane';
import { applySessionClioEvent, classifySessionClioSource, createSessionClioState, EvalQueryTrigger, isSessionClioSealed, SessionClioContradictionError, } from '@mavis/shared/session-clio';
const DUE_SCAN_LIMIT = 64;
const OUTBOX_CLAIM_LIMIT = 64;
const OUTBOX_BATCH_STEPS = 16;
/** Matches the existing eval report body ceiling for the shared gateway route. */
const OUTBOX_BATCH_BYTES = 6 << 20;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 30 * 60_000;
/**
 * Delivery budget for a batch the transport classified as non-retryable.
 *
 * The transport already decided the server will keep rejecting this exact
 * request; honoring that verdict on the first response would make one
 * transiently misclassifying middlebox (a gateway 400 mid-deploy) permanent,
 * so the batch gets this many total delivery attempts before it is retired.
 * Attempts are counted across all failures, so a batch that burned its budget
 * on network errors retires on its first permanent rejection — by then the
 * classification is not the flaky part.
 */
const NON_RETRYABLE_ATTEMPT_LIMIT = 3;
/**
 * `next_attempt_at_ms` for retired records: 9999-12-31T23:59:59.999Z.
 *
 * A retired row keeps its bytes and `last_error` on disk for inspection and
 * resubmission by a future migration, but is never claimed again: `claimReady`
 * filters on `next_attempt_at_ms <= now`, and this value is unreachable while
 * staying a plain readable timestamp rather than a magic flag column.
 */
const SESSION_CLIO_OUTBOX_RETIRED_AT_MS = 253_402_300_799_999;
/**
 * Drives the shared Session Clio lifecycle engine from the real desktop runtime
 * paths.
 *
 * Every method is total: a capture failure is reported and dropped rather than
 * propagated, because capture must never change a Turn's outcome. What it must
 * not do is lose a record silently — a state advance and its steps are committed
 * together, and uploads are retried from the durable outbox.
 */
export function createSessionClioCapture(options) {
    const lane = new KeyedOperationLane();
    let flushing;
    // Every flush path funnels through this one single-flight promise. The tick
    // used to call the flush routine directly on its own lane, so a timer flush
    // and an explicit flush could claim the same rows concurrently: both would
    // send, both would defer, and one real failure burned two attempts of the
    // per-record delivery budget.
    const flushShared = () => {
        flushing ??= flushPendingOutbox();
        return flushing;
    };
    const capture = {
        admitQuery: (input) => run(input.sessionId, () => admitQuery(options, lane, input)),
        bindTurn: (input) => run(input.sessionId, () => bindTurn(options, lane, input)),
        finalizeTurn: (input) => run(input.sessionId, () => finalizeTurn(options, lane, input)),
        tick: async () => {
            await run('tick', () => tick(options, lane));
            await flushShared();
        },
        flushOutbox: flushShared,
    };
    return capture;
    async function flushPendingOutbox() {
        try {
            await run('outbox', () => flushOutbox(options));
        }
        finally {
            flushing = undefined;
        }
    }
    async function run(sessionId, operation) {
        if (!options.enabled())
            return;
        try {
            await operation();
        }
        catch (error) {
            report(options, sessionId, error);
        }
    }
}
/**
 * Admits a genuine Query at its real submission, and — when the same moment is
 * also its consumption — binds it to the consuming turn in the same transaction.
 *
 * A queued Query must be admitted here at enqueue, never at dispatch: a query
 * that is enqueued and then expires, is cancelled, or dies with a failed batch
 * never dispatches, and nothing later in the Session would ever reveal it. Such
 * a Query is materialized at the seal as an Unfinished turn, which is the honest
 * "the user asked and the system never answered" record.
 */
async function admitQuery(options, lane, input) {
    const identity = options.identity.current();
    if (!identity)
        return;
    const kind = classifySessionClioSource(input.source);
    if (kind === 'internal')
        return;
    // A manual Query is what the user actually authored; an automatic one is the
    // preset instruction exactly as configured. Neither is the assembled prompt.
    const text = kind === 'manual' ? input.genuineUserQueryText : input.originalInstructionText;
    if (text.length === 0)
        return;
    await lane.run(laneKey(identity, input.sessionId), async () => {
        const opened = await openState(options, identity, input);
        if (!opened)
            return;
        const now = options.nowMs();
        // A producer retry is the same admission, not fresh user activity. Preserve
        // its original clock; the reducer still rejects changed text or provenance.
        const occurredAtMs = opened.state.queries.find((query) => query.query_id === input.queryId)?.occurred_at_ms ??
            input.occurredAtMs;
        const emitted = advance(opened.state, [
            {
                kind: 'query',
                query_id: input.queryId,
                text,
                occurred_at_ms: occurredAtMs,
                trigger: kind === 'manual' ? EvalQueryTrigger.Manual : EvalQueryTrigger.Automatic,
            },
            ...(input.turnId
                ? [
                    {
                        kind: 'turn',
                        turn_id: input.turnId,
                        query_ids: [input.queryId],
                        occurred_at_ms: occurredAtMs,
                    },
                ]
                : []),
            // The reducer checks the Query's actual submission against the cutoff
            // first. Processing latency must not erase timely activity; the final
            // tick still seals expired automatic inputs and retries without extending
            // their original clock.
            { kind: 'tick', now_ms: now },
        ]);
        options.store.commit({
            identity,
            sessionId: input.sessionId,
            trajectoryId: emitted.state.scope.trajectory_id,
            captureOrigin: options.captureOrigin,
            ...emitted,
            nowMs: now,
        });
    });
}
/**
 * Binds already-admitted Queries to the turn that actually consumed them, in
 * consumption order. Repeated calls for one turn append; they never mint a
 * second turn record.
 *
 * Query ids the capture never admitted are skipped rather than invented — a
 * queue item enqueued before this Session was enrolled has no admitted Query,
 * and fabricating one would break the `query_index` 1 attestation.
 */
async function bindTurn(options, lane, input) {
    const identity = options.identity.current();
    if (!identity)
        return;
    await lane.run(laneKey(identity, input.sessionId), () => {
        const row = options.store.read(identity.identityKey, input.sessionId);
        if (!row || row.eligibility !== 'enrolled' || !row.state)
            return Promise.resolve();
        if (isSessionClioSealed(row.state))
            return Promise.resolve();
        const admitted = new Set(row.state.queries.map((query) => query.query_id));
        const queryIds = input.queryIds.filter((queryId) => admitted.has(queryId));
        if (queryIds.length === 0)
            return Promise.resolve();
        const now = options.nowMs();
        const emitted = advance(row.state, [
            { kind: 'tick', now_ms: now },
            { kind: 'turn', turn_id: input.turnId, query_ids: queryIds, occurred_at_ms: now },
        ]);
        options.store.commit({
            identity,
            sessionId: input.sessionId,
            trajectoryId: emitted.state.scope.trajectory_id,
            captureOrigin: options.captureOrigin,
            ...emitted,
            nowMs: now,
        });
        return Promise.resolve();
    });
}
async function finalizeTurn(options, lane, input) {
    const identity = options.identity.current();
    if (!identity)
        return;
    await lane.run(laneKey(identity, input.sessionId), async () => {
        const row = options.store.read(identity.identityKey, input.sessionId);
        if (!row || row.eligibility !== 'enrolled' || !row.state)
            return;
        if (isSessionClioSealed(row.state))
            return;
        if (!row.state.turns.some((turn) => turn.turn_id === input.turnId))
            return;
        const answer = await options.finalAnswer.read(input);
        const now = options.nowMs();
        const emitted = advance(row.state, [
            { kind: 'tick', now_ms: now },
            {
                kind: 'terminal',
                turn_id: input.turnId,
                turn_status: input.status,
                ...(answer.text.length > 0 ? { final_response: answer.text } : {}),
                ...(answer.messageIds.length > 0 ? { final_message_ids: [...answer.messageIds] } : {}),
                occurred_at_ms: now,
            },
        ]);
        options.store.commit({
            identity,
            sessionId: input.sessionId,
            trajectoryId: emitted.state.scope.trajectory_id,
            captureOrigin: options.captureOrigin,
            ...emitted,
            nowMs: now,
        });
    });
}
async function tick(options, lane) {
    const due = options.store.listDue(options.nowMs(), DUE_SCAN_LIMIT);
    for (const candidate of due) {
        await lane.run(laneKey({ identityKey: candidate.identityKey }, candidate.sessionId), () => {
            const row = options.store.read(candidate.identityKey, candidate.sessionId);
            if (!row || row.eligibility !== 'enrolled' || !row.state)
                return Promise.resolve();
            if (isSessionClioSealed(row.state))
                return Promise.resolve();
            const now = options.nowMs();
            const emitted = advance(row.state, [{ kind: 'tick', now_ms: now }]);
            if (emitted.steps.length === 0)
                return Promise.resolve();
            options.store.commit({
                // A Session seals under the identity that captured it, never the live one.
                identity: { identityKey: candidate.identityKey, userId: 0, bizId: candidate.bizId },
                sessionId: candidate.sessionId,
                trajectoryId: emitted.state.scope.trajectory_id,
                captureOrigin: options.captureOrigin,
                ...emitted,
                nowMs: now,
            });
            return Promise.resolve();
        });
    }
    // No flush here: the capture facade chains the shared single-flight flush
    // after every tick, so timer-driven and explicit flushes never claim the
    // same rows twice.
}
async function flushOutbox(options) {
    const identity = options.identity.current();
    if (!identity || !options.transport.ready())
        return;
    const claimed = options.store.claimReady({
        identityKey: identity.identityKey,
        nowMs: options.nowMs(),
        limit: OUTBOX_CLAIM_LIMIT,
    });
    // A Session whose batch just failed must not have its later batches sent in
    // the same round: records travel in seq order, and delivering past a failure
    // would create exactly the hole the claim gate exists to prevent.
    let failedSessionId;
    for (const batch of batchBySession(claimed)) {
        const first = batch[0];
        if (!first || first.sessionId === failedSessionId)
            continue;
        // Re-check before every request: signing in as someone else mid-flush must
        // not ship one identity's records under another's credentials.
        if (options.identity.current()?.identityKey !== identity.identityKey)
            return;
        const seqs = batch.map((record) => record.seq);
        const result = await options.transport.send({
            trajectoryId: first.trajectoryId,
            captureOrigin: first.captureOrigin,
            sessionId: first.sessionId,
            records: batch,
        });
        if (result.status === 'skipped')
            return;
        if (result.status === 'sent') {
            // Business success for exactly these records; a hole is never closed by a
            // neighbour's acknowledgement.
            options.store.deleteSent({
                identityKey: identity.identityKey,
                sessionId: first.sessionId,
                seqs,
            });
            continue;
        }
        deferFailedBatch(options, { identityKey: identity.identityKey, batch, result });
        if (!result.retryable)
            return;
        failedSessionId = first.sessionId;
    }
}
/**
 * Defers a failed batch to its next attempt, or retires spent records for good.
 *
 * A non-retryable rejection consumes delivery budget instead of deferring
 * forever: the transport's classification means the server will keep rejecting
 * these exact bytes, and an immortal poisoned batch both hides the real defect
 * behind a 30-minute retry drone and wastes the flush round that claims it
 * ahead of healthy sessions.
 *
 * The budget is spent per record, not per batch: a claim round can put a
 * fresh record in the same batch as one that already burned two attempts, and
 * retiring the newcomer on its batch-mate's history would permanently park a
 * record that never got a delivery attempt of its own.
 */
function deferFailedBatch(options, input) {
    const { identityKey, batch, result } = input;
    const first = batch[0];
    if (!first)
        return;
    const retired = [];
    const deferred = [];
    let deferredAttempts = 0;
    for (const record of batch) {
        if (!result.retryable && record.attempts + 1 >= NON_RETRYABLE_ATTEMPT_LIMIT) {
            retired.push(record.seq);
        }
        else {
            deferred.push(record.seq);
            deferredAttempts = Math.max(deferredAttempts, record.attempts);
        }
    }
    if (retired.length > 0) {
        options.store.deferSent({
            identityKey,
            sessionId: first.sessionId,
            seqs: retired,
            nextAttemptAtMs: SESSION_CLIO_OUTBOX_RETIRED_AT_MS,
            reason: `retired: ${result.reason}`,
        });
    }
    if (deferred.length > 0) {
        options.store.deferSent({
            identityKey,
            sessionId: first.sessionId,
            seqs: deferred,
            // The longest history in the group sets the pace, so a retry storm
            // cannot be reset by a young batch-mate.
            nextAttemptAtMs: options.nowMs() + backoffMs(deferredAttempts),
            reason: result.reason,
        });
    }
    report(options, first.sessionId, new Error(`clio upload failed: ${result.reason}`));
}
/**
 * Reads or creates state for a Session.
 *
 * A Session that already had history when capture first saw it is durably
 * excluded and never reconsidered: `query_index` 1 is the source's attestation
 * that nothing earlier was missed, so opting in mid-history would be a lie.
 *
 * A Session another identity has already decided about is excluded for the same
 * reason. Signing in as someone else does not make an existing conversation a
 * new one, and the runtime tables alone cannot see that it was already captured.
 */
async function openState(options, identity, input) {
    const existing = options.store.read(identity.identityKey, input.sessionId);
    if (existing) {
        if (existing.eligibility !== 'enrolled' || !existing.state)
            return undefined;
        return isSessionClioSealed(existing.state) ? undefined : { state: existing.state };
    }
    const trajectoryId = options.trajectoryId(input.sessionId);
    if (options.store.hasForeignIdentity(identity.identityKey, input.sessionId) ||
        (await options.eligibility.hasHistoryBefore(input))) {
        options.store.exclude({
            identity,
            sessionId: input.sessionId,
            trajectoryId,
            captureOrigin: options.captureOrigin,
            nowMs: options.nowMs(),
        });
        return undefined;
    }
    return {
        state: createSessionClioState({
            user_id: identity.userId,
            biz_id: identity.bizId,
            capture_origin: options.captureOrigin,
            trajectory_id: trajectoryId,
        }),
    };
}
/**
 * Folds events through the pure engine. A contradiction propagates: it means the
 * caller bound something the source cannot honestly attest, and committing a
 * partial fold would corrupt the record set.
 */
function advance(initial, events) {
    let state = initial;
    const steps = [];
    for (const event of events) {
        const applied = applySessionClioEvent(state, event);
        state = applied.state;
        steps.push(...applied.steps);
    }
    return { state, steps };
}
/**
 * Groups claimed records into per-Session, sequence-ordered upload batches.
 *
 * A batch is bounded by both step count and serialized bytes so one large QA
 * turn cannot push a request past what the gateway route accepts. A single
 * record always gets its own batch rather than being dropped.
 */
function batchBySession(records) {
    const batches = [];
    let current = [];
    let currentBytes = 0;
    for (const record of records) {
        const head = current[0];
        const bytes = Buffer.byteLength(record.payloadJson, 'utf8');
        if (head &&
            (head.sessionId !== record.sessionId ||
                current.length >= OUTBOX_BATCH_STEPS ||
                currentBytes + bytes > OUTBOX_BATCH_BYTES)) {
            batches.push(current);
            current = [];
            currentBytes = 0;
        }
        current.push(record);
        currentBytes += bytes;
    }
    if (current.length > 0)
        batches.push(current);
    return batches;
}
function backoffMs(attempts) {
    return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempts, 8));
}
function laneKey(identity, sessionId) {
    return `${identity.identityKey}\u0000${sessionId}`;
}
function report(options, sessionId, error) {
    const prefix = error instanceof SessionClioContradictionError
        ? `session_clio_contradiction:${error.code}`
        : 'session_clio_capture_failed';
    try {
        const detail = error instanceof Error ? error.message : String(error);
        options.reportFailure?.(sessionId, `${prefix}:${detail}`);
    }
    catch {
        // Diagnostics must never become the failure they are reporting.
    }
}
//# sourceMappingURL=capture.js.map