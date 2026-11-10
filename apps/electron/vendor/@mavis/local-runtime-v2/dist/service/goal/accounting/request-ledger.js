/**
 * The Goal request ledger: one row per logical LLM request of Goal main
 * execution (`local_runtime_v2_goal_requests`, migration 47).
 *
 * A row is reserved before the request is sent, marked `dispatching` when its
 * first attempt is handed to the transport, and settled with every attempt's
 * known usage. While it is open, each attempt receipt records the usage known
 * so far. The row's token columns are the applied watermark: every write
 * charges the Goal the request was admitted for only their growth, in the
 * same transaction, so records and the settlement together charge each token
 * once. Charging never touches `updated_at_ms`: usage is a fact about the
 * Goal, not a decision about who owns its next step.
 *
 * While a request is open, `outcome` holds the last attempt's outcome exactly
 * when every attempt handed to the transport (`attempts`) has a durable
 * receipt; handing over the next attempt clears it. Startup recovery reads
 * that to tell a request whose result is known from one that may still have
 * been in flight.
 */
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { localRuntimeV2GoalRequests as requests } from '../../../infra/db/schema/goal.js';
import { chargeGoalTokens, countedTokens, readGoalTokenAccounting, sumAttemptUsage, } from './goal-tokens.js';
/**
 * Reserve one request. Re-reserving the same id for the same Goal Turn and
 * kind is a no-op; the same id with a different identity is a conflict, never
 * a second request.
 */
export function reserveGoalRequest(db, nowMs, input) {
    const existing = db
        .select({
        goalId: requests.goalId,
        turnId: requests.turnId,
        kind: requests.kind,
    })
        .from(requests)
        .where(eq(requests.requestId, input.requestId))
        .get();
    if (existing) {
        if (existing.goalId !== input.goalId ||
            existing.turnId !== input.turnId ||
            existing.kind !== input.kind) {
            throw new Error(`Goal request ${input.requestId} was reserved with a different identity`);
        }
        return 'duplicate';
    }
    db.insert(requests)
        .values({ ...input, phase: 'reserved', createdAtMs: nowMs, updatedAtMs: nowMs })
        .run();
    return 'reserved';
}
/**
 * An attempt is being handed to the transport: from now on it may have been
 * sent, and until its receipt is recorded the request's result is unknown.
 */
export function markGoalRequestDispatching(db, nowMs, input) {
    db.update(requests)
        .set({
        phase: sql `CASE WHEN ${requests.phase} = 'reserved' THEN 'dispatching' ELSE ${requests.phase} END`,
        attempts: sql `MAX(${requests.attempts}, ${input.requestAttempt})`,
        outcome: sql `CASE WHEN ${input.requestAttempt} > ${requests.attempts} THEN NULL ELSE ${requests.outcome} END`,
        updatedAtMs: nowMs,
    })
        .where(and(eq(requests.requestId, input.requestId), inArray(requests.phase, ['reserved', 'dispatching'])))
        .run();
}
/**
 * Record the known usage of an open request's attempts so far, as soon as an
 * attempt reports it (spec §4.4). The request stays open. Its Goal is charged
 * only the growth over what the row already holds, so a repeated, stale or
 * reordered record charges nothing and the settlement later charges only the
 * rest (§4.5). When the receipts cover every attempt handed to the transport,
 * the last one's outcome is kept with them in the same write. A request whose
 * Goal was deleted is left for its settlement to discard.
 */
export function recordGoalRequestAttempts(db, nowMs, input) {
    const row = readRequest(db, input.requestId);
    if (!isOpen(row) || input.attempts.length === 0)
        return { kind: 'ignored' };
    const accounting = readGoalTokenAccounting(db, row.goalId);
    if (!accounting)
        return { kind: 'ignored' };
    const usage = raiseUsage(row, accounting, input.attempts);
    // An older list (fewer receipts than attempts handed over) leaves the outcome as it is.
    const outcome = input.attempts.length >= row.attempts
        ? (input.attempts.at(-1)?.outcome ?? row.outcome)
        : row.outcome;
    if (holdsUsage(row, usage) && outcome === row.outcome)
        return { kind: 'ignored' };
    db.update(requests)
        .set({ ...usageColumns(usage), outcome, updatedAtMs: nowMs })
        .where(eq(requests.requestId, input.requestId))
        .run();
    return {
        kind: 'recorded',
        goalId: row.goalId,
        tokens: chargeGrowth(db, row, accounting, usage),
    };
}
/**
 * Settle one request with every attempt's receipt. A request whose attempts
 * never reached the transport is voided and releases its reservation. Tokens
 * are charged to the Goal the request was admitted for, and only once: the
 * settlement charges only what its attempt records have not, and a repeated
 * settlement finds the row already settled. `tokens` is the request's total.
 */
export function settleGoalRequest(db, nowMs, input) {
    const row = readRequest(db, input.requestId);
    if (!isOpen(row))
        return { kind: 'ignored' };
    const requestKind = row.kind === 'grace' ? 'grace' : 'work';
    if (input.attempts.length === 0) {
        db.update(requests)
            .set({ phase: 'voided', outcome: input.outcome, updatedAtMs: nowMs })
            .where(eq(requests.requestId, input.requestId))
            .run();
        return { kind: 'voided', goalId: row.goalId, requestKind };
    }
    const accounting = readGoalTokenAccounting(db, row.goalId);
    const applies = accounting !== undefined;
    const usage = raiseUsage(row, accounting ?? 'legacy', input.attempts);
    db.update(requests)
        .set({
        phase: applies ? 'settled' : 'discarded',
        outcome: input.outcome,
        attempts: sql `MAX(${requests.attempts}, ${input.attempts.length})`,
        ...usageColumns(usage),
        ...(applies ? {} : { discardReason: 'goal_deleted' }),
        updatedAtMs: nowMs,
    })
        .where(eq(requests.requestId, input.requestId))
        .run();
    if (!applies)
        return { kind: 'discarded', goalId: row.goalId, reason: 'goal_deleted' };
    chargeGrowth(db, row, accounting, usage);
    return {
        kind: 'applied',
        goalId: row.goalId,
        requestKind,
        tokens: countedTokens(accounting, usage),
    };
}
/**
 * Startup recovery for requests the previous process left open (spec §4.1,
 * §4.5). A request that never reached the transport is released. One whose
 * every attempt handed to the transport has a durable receipt was delivered
 * and its result is known: its recorded usage (already charged) is settled
 * as it stands, keeping its own completeness. One that may still have had an
 * attempt in flight keeps its occupancy as unknown, is never re-sent, and
 * keeps the usage its attempts already recorded with the rest marked unknown.
 */
export function recoverInterruptedGoalRequests(db, nowMs) {
    const voided = db
        .update(requests)
        .set({ phase: 'voided', updatedAtMs: nowMs })
        .where(eq(requests.phase, 'reserved'))
        .run().changes;
    const settled = db
        .update(requests)
        .set({ phase: 'settled', updatedAtMs: nowMs })
        .where(and(eq(requests.phase, 'dispatching'), isNotNull(requests.outcome)))
        .run().changes;
    const unresolved = db
        .update(requests)
        .set({ phase: 'unresolved', usageIncomplete: true, updatedAtMs: nowMs })
        .where(eq(requests.phase, 'dispatching'))
        .run().changes;
    return { voided, settled, unresolved };
}
function readRequest(db, requestId) {
    return db
        .select({
        goalId: requests.goalId,
        phase: requests.phase,
        kind: requests.kind,
        inputTokens: requests.inputTokens,
        outputTokens: requests.outputTokens,
        cacheReadTokens: requests.cacheReadTokens,
        cacheWriteTokens: requests.cacheWriteTokens,
        usageIncomplete: requests.usageIncomplete,
        attempts: requests.attempts,
        outcome: requests.outcome,
    })
        .from(requests)
        .where(eq(requests.requestId, requestId))
        .get();
}
/** Reserved or dispatching: the request may still record and settle usage. */
function isOpen(row) {
    return row?.phase === 'reserved' || row?.phase === 'dispatching';
}
/**
 * The attempts' known usage, never below what the row already holds: the
 * receipts of one request only grow, so an older list never lowers the
 * applied watermark.
 */
function raiseUsage(row, accounting, attempts) {
    const known = sumAttemptUsage(accounting, attempts);
    return {
        input: Math.max(row.inputTokens, known.input),
        output: Math.max(row.outputTokens, known.output),
        cacheRead: Math.max(row.cacheReadTokens, known.cacheRead),
        cacheWrite: Math.max(row.cacheWriteTokens, known.cacheWrite),
        incomplete: row.usageIncomplete || known.incomplete,
        cacheWriteUnreported: known.cacheWriteUnreported,
    };
}
function holdsUsage(row, usage) {
    return (row.inputTokens === usage.input &&
        row.outputTokens === usage.output &&
        row.cacheReadTokens === usage.cacheRead &&
        row.cacheWriteTokens === usage.cacheWrite &&
        row.usageIncomplete === usage.incomplete);
}
function usageColumns(usage) {
    return {
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
        usageIncomplete: usage.incomplete,
    };
}
/** Charge the Goal the growth of the request's counted tokens over the row's watermark. */
function chargeGrowth(db, row, accounting, usage) {
    return chargeGoalTokens(db, {
        goalId: row.goalId,
        accounting,
        applied: {
            input: row.inputTokens,
            output: row.outputTokens,
            cacheRead: row.cacheReadTokens,
            cacheWrite: row.cacheWriteTokens,
        },
        usage,
    });
}
//# sourceMappingURL=request-ledger.js.map