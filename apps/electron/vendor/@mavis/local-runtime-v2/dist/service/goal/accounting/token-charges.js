/**
 * Token charges of a full-usage Goal for requests outside the request ledger
 * (`local_runtime_v2_goal_token_charges`, migration 48): automatic compaction
 * in a Goal Turn, and every request of a sub-session round a Goal Turn started
 * (subagent tasks, the subagent verifier, their compaction, and rounds those
 * started in turn).
 *
 * These requests count tokens only. They are not Goal requests: they take no
 * work budget, are never reserved or admitted, and never appear in the request
 * counts. One row per logical request; its token columns are the applied
 * watermark, exactly as on the ledger, so a repeated, stale or reordered
 * report charges the Goal nothing and each token is charged once. A legacy
 * Goal is never charged here: its accounting stays what it was.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { localRuntimeV2GoalTokenCharges as charges } from '../../../infra/db/schema/goal.js';
import { chargeGoalTokens, readGoalTokenAccounting, sumAttemptUsage, } from './goal-tokens.js';
/**
 * Record one request's known usage and charge the Goal its growth, in the
 * caller's transaction. With `outcome` the request is settled.
 */
export function chargeGoalTokenRequest(db, nowMs, input) {
    const row = readCharge(db, input.requestId);
    if (row && row.phase !== 'open')
        return { kind: 'ignored' };
    if (input.attempts.length === 0 && input.outcome === undefined)
        return { kind: 'ignored' };
    const accounting = readGoalTokenAccounting(db, input.goalId);
    if (accounting === 'legacy')
        return { kind: 'ignored' };
    const usage = raiseUsage(row, sumAttemptUsage('full', input.attempts));
    const settled = input.outcome !== undefined;
    if (!accounting) {
        // Usage that arrives after its Goal was deleted is dropped, never moved
        // to whichever Goal the Session has now.
        if (!settled)
            return { kind: 'ignored' };
        writeRow(db, input, row, { nowMs, usage, phase: 'discarded', discardReason: 'goal_deleted' });
        return { kind: 'discarded', goalId: input.goalId, reason: 'goal_deleted' };
    }
    writeRow(db, input, row, { nowMs, usage, phase: settled ? 'settled' : 'open' });
    return {
        kind: 'charged',
        goalId: input.goalId,
        tokens: chargeGoalTokens(db, {
            goalId: input.goalId,
            accounting: 'full',
            applied: applied(row),
            usage,
        }),
    };
}
/**
 * Startup recovery: a request the previous process left open keeps the usage
 * it already charged and is marked unresolved with incomplete usage; nothing is
 * estimated.
 */
export function recoverInterruptedGoalTokenCharges(db, nowMs) {
    return db
        .update(charges)
        .set({ phase: 'unresolved', usageIncomplete: true, updatedAtMs: nowMs })
        .where(eq(charges.phase, 'open'))
        .run().changes;
}
/** Whether a charged request of this Goal is missing usage. */
export function goalTokenChargesIncomplete(db, goalId) {
    return Boolean(db
        .select({ requestId: charges.requestId })
        .from(charges)
        .where(and(eq(charges.goalId, goalId), eq(charges.usageIncomplete, true), inArray(charges.phase, ['open', 'settled', 'unresolved'])))
        .get());
}
function readCharge(db, requestId) {
    return db
        .select({
        phase: charges.phase,
        attempts: charges.attempts,
        inputTokens: charges.inputTokens,
        outputTokens: charges.outputTokens,
        cacheReadTokens: charges.cacheReadTokens,
        cacheWriteTokens: charges.cacheWriteTokens,
        usageIncomplete: charges.usageIncomplete,
    })
        .from(charges)
        .where(eq(charges.requestId, requestId))
        .get();
}
function applied(row) {
    return {
        input: row?.inputTokens ?? 0,
        output: row?.outputTokens ?? 0,
        cacheRead: row?.cacheReadTokens ?? 0,
        cacheWrite: row?.cacheWriteTokens ?? 0,
    };
}
/** Reports of one request only grow: an older list never lowers the watermark. */
function raiseUsage(row, known) {
    const held = applied(row);
    return {
        input: Math.max(held.input, known.input),
        output: Math.max(held.output, known.output),
        cacheRead: Math.max(held.cacheRead, known.cacheRead),
        cacheWrite: Math.max(held.cacheWrite, known.cacheWrite),
        incomplete: (row?.usageIncomplete ?? false) || known.incomplete,
        cacheWriteUnreported: known.cacheWriteUnreported,
    };
}
function writeRow(db, input, row, state) {
    const { nowMs, usage } = state;
    const columns = {
        phase: state.phase,
        attempts: Math.max(row?.attempts ?? 0, input.attempts.length),
        ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
        usageIncomplete: usage.incomplete,
        ...(state.discardReason ? { discardReason: state.discardReason } : {}),
        updatedAtMs: nowMs,
    };
    if (row) {
        db.update(charges).set(columns).where(eq(charges.requestId, input.requestId)).run();
        return;
    }
    db.insert(charges)
        .values({
        requestId: input.requestId,
        goalId: input.goalId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        source: input.source,
        createdAtMs: nowMs,
        ...columns,
    })
        .run();
}
//# sourceMappingURL=token-charges.js.map