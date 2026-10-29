/**
 * Reads of the Goal request ledger: the accounting projection published on a
 * Goal and the per-Turn wrap-up count that the request barrier checks.
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { localRuntimeV2GoalRequests as requests } from '../../../infra/db/schema/goal.js';
import { goalTokenChargesIncomplete } from './token-charges.js';
/** Rows that occupy work budget: everything except a voided or discarded request. */
const OCCUPYING_PHASES = ['reserved', 'dispatching', 'settled', 'unresolved'];
/** The accounting projection of one Goal, from the ledger and its frozen legacy turns. */
export function readGoalRequestAccounting(db, goalId, legacyTurns) {
    const rows = db
        .select({
        kind: requests.kind,
        phase: requests.phase,
        count: sql `COUNT(*)`,
        incomplete: sql `MAX(${requests.usageIncomplete})`,
    })
        .from(requests)
        .where(and(eq(requests.goalId, goalId), ne(requests.phase, 'voided')))
        .groupBy(requests.kind, requests.phase)
        .all();
    const count = (kind, phases) => rows
        .filter((row) => (kind === undefined || row.kind === kind) && phases.includes(row.phase))
        .reduce((total, row) => total + Number(row.count), 0);
    const workRequests = count('work', ['settled']);
    const graceRequests = count('grace', ['settled']);
    const unknownRequests = count(undefined, ['unresolved']);
    return {
        version: 2,
        requestsUsed: workRequests + graceRequests + unknownRequests,
        workRequests,
        graceRequests,
        legacyTurns,
        reservedRequests: count(undefined, ['reserved', 'dispatching']),
        unknownRequests,
        // Requests charged outside the ledger (compaction, sub-sessions) count too.
        usageIncomplete: rows.some((row) => row.phase !== 'discarded' && Number(row.incomplete) > 0) ||
            goalTokenChargesIncomplete(db, goalId),
        workOccupied: legacyTurns + count('work', OCCUPYING_PHASES),
        goalTurns: legacyTurns + countWorkTurns(db, goalId),
    };
}
function countWorkTurns(db, goalId) {
    const row = db
        .select({ count: sql `COUNT(DISTINCT ${requests.turnId})` })
        .from(requests)
        .where(and(eq(requests.goalId, goalId), eq(requests.kind, 'work'), inArray(requests.phase, OCCUPYING_PHASES)))
        .get();
    return Number(row?.count ?? 0);
}
/** Wrap-up requests of one Goal Turn that still occupy its wrap-up allowance. */
export function countTurnGraceRequests(db, turnId) {
    const row = db
        .select({ count: sql `COUNT(*)` })
        .from(requests)
        .where(and(eq(requests.turnId, turnId), eq(requests.kind, 'grace'), inArray(requests.phase, OCCUPYING_PHASES)))
        .get();
    return Number(row?.count ?? 0);
}
//# sourceMappingURL=request-projection.js.map