import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import { tokenUsage } from '../../../../infra/db/schema/usage.js';
import { validateUsageInsert } from './policy.js';
export function createSessionUsageRepository(options) {
    return new DrizzleSessionUsageRepository(options);
}
class DrizzleSessionUsageRepository {
    options;
    constructor(options) {
        this.options = options;
    }
    async append(row) {
        validateUsageInsert(row);
        this.options.db.insert(tokenUsage).values(encode(row)).run();
    }
    async listBySession(sessionId, range) {
        return this.options.db
            .select()
            .from(tokenUsage)
            .where(and(eq(tokenUsage.sessionId, sessionId), usageRangePredicate(range)))
            .orderBy(asc(tokenUsage.timestamp), asc(tokenUsage.id))
            .all()
            .map(decode);
    }
    async summarizeBySession(sessionId, range) {
        return this.summarize(and(eq(tokenUsage.sessionId, sessionId), usageRangePredicate(range)));
    }
    async summarizeGlobal(range) {
        return this.summarize(usageRangePredicate(range));
    }
    async summarizeGroupBy(group, range) {
        const key = usageGroupExpression(group);
        return this.options.db
            .select({ key, ...usageSummarySelection() })
            .from(tokenUsage)
            .where(usageRangePredicate(range))
            .groupBy(key)
            .orderBy(asc(key))
            .all()
            .map((row) => ({ key: usageGroupKey(group, row.key), summary: summaryFromRow(row) }));
    }
    async deleteSession(sessionId) {
        this.options.db.delete(tokenUsage).where(eq(tokenUsage.sessionId, sessionId)).run();
    }
    summarize(predicate) {
        const row = this.options.db
            .select(usageSummarySelection())
            .from(tokenUsage)
            .where(predicate)
            .get();
        return summaryFromRow(row ?? emptySummaryRow());
    }
}
function encode(row) {
    return {
        sessionId: row.sessionId,
        agentName: row.agentName,
        frameworkType: row.frameworkType,
        turnId: row.turnId,
        model: row.model,
        timestamp: row.ts,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        reasoningTokens: row.reasoningTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        costUsd: row.costUsd,
        raw: row.raw,
    };
}
function decode(row) {
    return {
        id: row.id,
        sessionId: row.sessionId,
        agentName: row.agentName,
        frameworkType: row.frameworkType,
        turnId: row.turnId,
        model: row.model,
        ts: row.timestamp,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        reasoningTokens: row.reasoningTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        costUsd: row.costUsd,
        raw: row.raw,
    };
}
function usageRangePredicate(range) {
    return and(range?.from === undefined ? undefined : gte(tokenUsage.timestamp, range.from), range?.to === undefined ? undefined : lte(tokenUsage.timestamp, range.to));
}
function usageGroupExpression(group) {
    if (group === 'agent')
        return sql `${tokenUsage.agentName}`;
    if (group === 'session')
        return sql `${tokenUsage.sessionId}`;
    if (group === 'model')
        return sql `coalesce(${tokenUsage.model}, 'unknown')`;
    return sql `CAST(${tokenUsage.timestamp} / 86400000 AS INTEGER)`.mapWith(Number);
}
function usageGroupKey(group, value) {
    if (group !== 'day')
        return String(value);
    const date = new Date(Number(value) * 86_400_000);
    const year = String(date.getUTCFullYear()).padStart(4, '0');
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
function usageSummarySelection() {
    return {
        inputTokens: sql `coalesce(sum(${tokenUsage.inputTokens}), 0)`.mapWith(Number),
        outputTokens: sql `coalesce(sum(${tokenUsage.outputTokens}), 0)`.mapWith(Number),
        reasoningTokens: sql `coalesce(sum(${tokenUsage.reasoningTokens}), 0)`.mapWith(Number),
        cacheReadTokens: sql `coalesce(sum(${tokenUsage.cacheReadTokens}), 0)`.mapWith(Number),
        cacheWriteTokens: sql `coalesce(sum(${tokenUsage.cacheWriteTokens}), 0)`.mapWith(Number),
        costUsd: sql `coalesce(sum(${tokenUsage.costUsd}), 0)`.mapWith(Number),
        turns: sql `count(*)`.mapWith(Number),
    };
}
function emptySummaryRow() {
    return {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        turns: 0,
    };
}
function summaryFromRow(totals) {
    return {
        ...totals,
        totalTokens: totals.inputTokens + totals.outputTokens + totals.reasoningTokens,
    };
}
//# sourceMappingURL=drizzle.js.map