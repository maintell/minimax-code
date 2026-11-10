import { withLocalRuntimeDb } from './db.js';
import {} from './database-contracts.js';
import { normalizePositiveInteger, numericOrZero } from './sqlite-persistence-values.js';
const TOKEN_USAGE_SUMMARY_SELECT = `
  COALESCE(SUM(input_tokens), 0) AS input,
  COALESCE(SUM(output_tokens), 0) AS output,
  COALESCE(SUM(reasoning_tokens), 0) AS reasoning,
  COALESCE(SUM(cache_read_tokens), 0) AS cacheRead,
  COALESCE(SUM(cache_write_tokens), 0) AS cacheWrite,
  COALESCE(SUM(cost_usd), 0) AS cost,
  COUNT(*) AS turns
`;
export class SqliteLocalTokenUsageStore {
    dataDir;
    constructor(dataDir) {
        this.dataDir = dataDir;
    }
    async append(usage) {
        this.withDb((db) => {
            db.prepare(`
        INSERT INTO local_runtime_token_usage (
          session_id, agent_name, framework_type, turn_id, model, ts,
          input_tokens, output_tokens, reasoning_tokens,
          cache_read_tokens, cache_write_tokens, cost_usd, raw
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(usage.sessionId, usage.agentName, usage.frameworkType, usage.turnId, usage.model, usage.ts, usage.inputTokens, usage.outputTokens, usage.reasoningTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.costUsd, usage.raw);
        });
    }
    async listBySession(sessionId, opts) {
        return this.withDb((db) => {
            const limit = normalizePositiveInteger(opts?.limit);
            const rows = limit === undefined
                ? db
                    .prepare(`
                SELECT * FROM local_runtime_token_usage
                WHERE session_id = ?
                ORDER BY ts ASC, id ASC
              `)
                    .all(sessionId)
                : db
                    .prepare(`
                SELECT * FROM local_runtime_token_usage
                WHERE session_id = ?
                ORDER BY ts ASC, id ASC
                LIMIT ?
              `)
                    .all(sessionId, limit);
            return rows.map(tokenUsageRowToProtocol);
        });
    }
    async listByAgent(agentName, opts) {
        return this.withDb((db) => {
            const { where, params } = buildTokenUsageWhere({
                agentName,
                agentNames: opts?.agentNames,
                from: opts?.from,
                to: opts?.to,
            });
            const limit = normalizePositiveInteger(opts?.limit);
            const sql = `
        SELECT * FROM local_runtime_token_usage
        WHERE ${where.join(' AND ')}
        ORDER BY ts ASC, id ASC
        ${limit !== undefined ? 'LIMIT ?' : ''}
      `;
            const rows = db.prepare(sql).all(...params, ...(limit !== undefined ? [limit] : []));
            return rows.map(tokenUsageRowToProtocol);
        });
    }
    async summarizeBySession(sessionId) {
        return this.withDb((db) => {
            const row = db
                .prepare(`
          SELECT ${TOKEN_USAGE_SUMMARY_SELECT}
          FROM local_runtime_token_usage
          WHERE session_id = ?
        `)
                .get(sessionId);
            return tokenUsageSummaryToProtocol(row);
        });
    }
    async summarizeByAgent(agentName, opts) {
        return this.withDb((db) => {
            const { where, params } = buildTokenUsageWhere({
                agentName,
                agentNames: opts?.agentNames,
                from: opts?.from,
                to: opts?.to,
            });
            const row = db
                .prepare(`
          SELECT ${TOKEN_USAGE_SUMMARY_SELECT}
          FROM local_runtime_token_usage
          WHERE ${where.join(' AND ')}
        `)
                .get(...params);
            return tokenUsageSummaryToProtocol(row);
        });
    }
    async summarizeGlobal(opts) {
        return this.withDb((db) => {
            const { where, params } = buildTokenUsageWhere({
                agentNames: opts?.agentNames,
                from: opts?.from,
                to: opts?.to,
            });
            const row = db
                .prepare(`
          SELECT ${TOKEN_USAGE_SUMMARY_SELECT}
          FROM local_runtime_token_usage
          WHERE ${where.join(' AND ')}
        `)
                .get(...params);
            return tokenUsageSummaryToProtocol(row);
        });
    }
    async summarizeGroupBy(groupBy, opts) {
        return this.withDb((db) => {
            const groupExpr = tokenUsageGroupExpression(groupBy);
            const { where, params } = buildTokenUsageWhere(opts ?? {});
            const rows = db
                .prepare(`
          SELECT ${groupExpr} AS group_key,
                 ${TOKEN_USAGE_SUMMARY_SELECT}
          FROM local_runtime_token_usage
          WHERE ${where.join(' AND ')}
          GROUP BY ${groupExpr}
          ORDER BY group_key ASC
        `)
                .all(...params);
            return rows.map((row) => ({
                key: row.group_key ?? 'unknown',
                summary: tokenUsageSummaryToProtocol(row),
            }));
        });
    }
    async deleteSession(sessionId) {
        this.withDb((db) => {
            db.prepare('DELETE FROM local_runtime_token_usage WHERE session_id = ?').run(sessionId);
        });
    }
    withDb(fn) {
        return withLocalRuntimeDb(this.dataDir, fn);
    }
}
function tokenUsageRowToProtocol(row) {
    return {
        id: numericOrZero(row.id),
        sessionId: row.session_id ?? '',
        agentName: row.agent_name ?? '',
        frameworkType: row.framework_type ?? 'pi-agent',
        turnId: row.turn_id ?? null,
        model: row.model ?? null,
        ts: numericOrZero(row.ts),
        inputTokens: numericOrZero(row.input_tokens),
        outputTokens: numericOrZero(row.output_tokens),
        reasoningTokens: numericOrZero(row.reasoning_tokens),
        cacheReadTokens: numericOrZero(row.cache_read_tokens),
        cacheWriteTokens: numericOrZero(row.cache_write_tokens),
        costUsd: typeof row.cost_usd === 'number' && Number.isFinite(row.cost_usd) ? row.cost_usd : null,
        raw: row.raw ?? null,
    };
}
function tokenUsageSummaryToProtocol(row) {
    const inputTokens = numericOrZero(row?.input);
    const outputTokens = numericOrZero(row?.output);
    const reasoningTokens = numericOrZero(row?.reasoning);
    const cacheReadTokens = numericOrZero(row?.cacheRead);
    const cacheWriteTokens = numericOrZero(row?.cacheWrite);
    return {
        inputTokens,
        outputTokens,
        reasoningTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalTokens: inputTokens + outputTokens + reasoningTokens,
        costUsd: numericOrZero(row?.cost),
        turns: numericOrZero(row?.turns),
    };
}
function buildTokenUsageWhere(opts) {
    const where = ['1 = 1'];
    const params = [];
    const agentNames = normalizeAgentNames(opts.agentNames);
    if (opts.agentNames !== undefined) {
        if (agentNames.length === 0) {
            where.push('0 = 1');
        }
        else {
            where.push(`agent_name IN (${agentNames.map(() => '?').join(', ')})`);
            params.push(...agentNames);
        }
    }
    else if (opts.agentName !== undefined) {
        where.push('agent_name = ?');
        params.push(opts.agentName);
    }
    if (opts.sessionId !== undefined) {
        where.push('session_id = ?');
        params.push(opts.sessionId);
    }
    if (opts.from !== undefined) {
        where.push('ts >= ?');
        params.push(opts.from);
    }
    if (opts.to !== undefined) {
        where.push('ts <= ?');
        params.push(opts.to);
    }
    return { where, params };
}
function normalizeAgentNames(agentNames) {
    if (agentNames === undefined)
        return [];
    return [...new Set(agentNames)].filter((name) => name.length > 0);
}
function tokenUsageGroupExpression(groupBy) {
    switch (groupBy) {
        case 'agent':
            return 'agent_name';
        case 'session':
            return 'session_id';
        case 'model':
            return "COALESCE(model, 'unknown')";
        case 'day':
            return "strftime('%Y-%m-%d', ts / 1000, 'unixepoch')";
    }
}
//# sourceMappingURL=sqlite-token-usage-store.js.map