/**
 * Token arithmetic shared by every path that charges a Goal: the request
 * ledger (Goal main execution) and the token charges of requests outside it
 * (automatic compaction, sub-sessions, the subagent verifier).
 *
 * A Goal is metered under one accounting for its whole life
 * (`token_accounting_version`). Legacy Goals (version 1) count input + output;
 * full-usage Goals (version 2) count input + cache write + cache read +
 * output, the four parts pi-ai normalizes disjointly, summed directly, and
 * keep each part.
 */
import { isFirstPartyMinimaxMessagesRoute } from '@mavis/config';
import { eq, sql } from 'drizzle-orm';
import { FULL_USAGE_TOKEN_ACCOUNTING, localRuntimeV2Goals as goals, } from '../../../infra/db/schema/goal.js';
/** The accounting a Goal is metered under, or `undefined` when the Goal is gone. */
export function readGoalTokenAccounting(db, goalId) {
    const row = db
        .select({ version: goals.tokenAccountingVersion })
        .from(goals)
        .where(eq(goals.goalId, goalId))
        .get();
    if (!row)
        return undefined;
    return row.version === FULL_USAGE_TOKEN_ACCOUNTING ? 'full' : 'legacy';
}
/**
 * MiniMax's first-party Messages route counts the tokens it writes to the
 * cache as input and always reports a cache write of 0, so on that route the
 * 0 says nothing. Every other route reports the cache write it made.
 */
function reportsCacheWrite(route) {
    return route === undefined || !isFirstPartyMinimaxMessagesRoute(route.api, route.provider);
}
/** Tokens a request's usage is worth under one accounting. */
export function countedTokens(accounting, usage) {
    return accounting === 'full'
        ? usage.input + usage.cacheWrite + usage.cacheRead + usage.output
        : usage.input + usage.output;
}
/**
 * Sum every attempt's known usage. A sent attempt whose usage is unknown marks
 * the request incomplete, however it ended; missing usage is never read as
 * zero consumption. Unknown means, for a legacy Goal, no input or output
 * reported, or a partial report; for a full-usage Goal, also any attempt that
 * ended in `error` or `abort` (it reported only what arrived before it ended)
 * and an attempt whose four parts are all zero. A request that only read from
 * the cache reported real usage.
 */
export function sumAttemptUsage(accounting, attempts) {
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let incomplete = false;
    let cacheWriteUnreported = false;
    for (const attempt of attempts) {
        const usage = attempt.usage;
        if (usage && !reportsCacheWrite(attempt.route))
            cacheWriteUnreported = true;
        const parts = {
            input: tokenCount(usage?.input),
            output: tokenCount(usage?.output),
            cacheRead: tokenCount(usage?.cacheRead),
            cacheWrite: tokenCount(usage?.cacheWrite),
        };
        input += parts.input;
        output += parts.output;
        cacheRead += parts.cacheRead;
        cacheWrite += parts.cacheWrite;
        if (accounting === 'full') {
            if (!attempt.usageComplete || attempt.outcome !== 'success')
                incomplete = true;
        }
        else if (!attempt.usageComplete && usage) {
            incomplete = true;
        }
        if (countedTokens(accounting, parts) === 0)
            incomplete = true;
    }
    return { input, output, cacheRead, cacheWrite, incomplete, cacheWriteUnreported };
}
/**
 * Charge a Goal the growth of one request's usage over what was already
 * applied, in the caller's transaction. Returns the tokens newly counted. A
 * full-usage Goal charged any request whose cache write was unreported keeps
 * that mark for good: its cache write total is no longer a measurement.
 */
export function chargeGoalTokens(db, charge) {
    const { goalId, accounting, applied, usage } = charge;
    const growth = {
        input: Math.max(0, usage.input - applied.input),
        output: Math.max(0, usage.output - applied.output),
        cacheRead: Math.max(0, usage.cacheRead - applied.cacheRead),
        cacheWrite: Math.max(0, usage.cacheWrite - applied.cacheWrite),
    };
    const tokens = countedTokens(accounting, growth);
    if (tokens <= 0)
        return 0;
    db.update(goals)
        .set(accounting === 'full'
        ? {
            tokensUsed: sql `${goals.tokensUsed} + ${tokens}`,
            inputTokens: sql `${goals.inputTokens} + ${growth.input}`,
            cacheWriteTokens: sql `${goals.cacheWriteTokens} + ${growth.cacheWrite}`,
            cacheReadTokens: sql `${goals.cacheReadTokens} + ${growth.cacheRead}`,
            outputTokens: sql `${goals.outputTokens} + ${growth.output}`,
            ...(usage.cacheWriteUnreported ? { cacheWriteUnreported: true } : {}),
        }
        : { tokensUsed: sql `${goals.tokensUsed} + ${tokens}` })
        .where(eq(goals.goalId, goalId))
        .run();
    return tokens;
}
function tokenCount(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
//# sourceMappingURL=goal-tokens.js.map