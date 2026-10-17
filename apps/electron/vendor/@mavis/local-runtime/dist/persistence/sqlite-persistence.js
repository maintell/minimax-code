import { withLocalRuntimeDb } from './db.js';
import { pruneExpiredTurnDiffs } from './turn-diff-retention.js';
import { advanceSessionAssetIndexStateInTransaction, clearSessionAssetRowsInTransaction, deleteSessionAssetDataInTransaction, deleteSessionAssetRowsForMessagesInTransaction, indexDisplayMessageAssetsInTransaction, initSessionAssetIndexStateInTransaction, markSessionAssetIndexReadyInTransaction, rebuildSessionAssetsInTransaction, } from '../session-assets/session-asset-index.js';
import { applyLocalSessionListOptions } from '../sessions/list-options.js';
const TOKEN_USAGE_SUMMARY_SELECT = `
  COALESCE(SUM(input_tokens), 0) AS input,
  COALESCE(SUM(output_tokens), 0) AS output,
  COALESCE(SUM(reasoning_tokens), 0) AS reasoning,
  COALESCE(SUM(cache_read_tokens), 0) AS cacheRead,
  COALESCE(SUM(cache_write_tokens), 0) AS cacheWrite,
  COALESCE(SUM(cost_usd), 0) AS cost,
  COUNT(*) AS turns
`;
export class SqliteLocalSessionStore {
    dataDir;
    constructor(dataDir) {
        this.dataDir = dataDir;
    }
    async get(sessionId) {
        return this.withDb((db) => {
            const row = db
                .prepare('SELECT record_json FROM local_runtime_sessions WHERE session_id = ?')
                .get(sessionId);
            return parseJson(row?.record_json);
        });
    }
    async upsert(record) {
        this.withDb((db) => {
            db.prepare(`
        INSERT INTO local_runtime_sessions (session_id, record_json, updated_at_ms)
        VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          record_json = excluded.record_json,
          updated_at_ms = excluded.updated_at_ms
      `).run(record.sessionId, JSON.stringify(record), record.updatedAtMs);
        });
    }
    async delete(sessionId) {
        this.withDb((db) => {
            db.prepare('DELETE FROM local_runtime_sessions WHERE session_id = ?').run(sessionId);
        });
    }
    async list(options) {
        return this.withDb((db) => {
            const scanLimit = normalizeScanLimit(options?.scanLimit);
            // The DESC recency order walks idx_local_runtime_sessions_updated_at
            // backwards, so a scanLimit stops the scan after N index entries
            // instead of loading and parsing the whole table.
            const rows = scanLimit !== undefined
                ? db
                    .prepare('SELECT record_json FROM local_runtime_sessions ORDER BY updated_at_ms DESC LIMIT ?')
                    .all(scanLimit)
                : db
                    .prepare('SELECT record_json FROM local_runtime_sessions ORDER BY updated_at_ms DESC')
                    .all();
            const records = rows.flatMap((row) => {
                const record = parseJson(row.record_json);
                return record ? [record] : [];
            });
            return applyLocalSessionListOptions(records, options);
        });
    }
    withDb(fn) {
        return withLocalRuntimeDb(this.dataDir, fn);
    }
}
export class SqliteLocalAgentStore {
    dataDir;
    constructor(dataDir) {
        this.dataDir = dataDir;
    }
    async get(name) {
        return this.withDb((db) => {
            const row = db
                .prepare('SELECT record_json FROM local_runtime_agents WHERE name = ?')
                .get(name);
            return parseJson(row?.record_json);
        });
    }
    async upsert(record) {
        this.withDb((db) => {
            db.prepare(`
        INSERT INTO local_runtime_agents (name, record_json, updated_at_ms)
        VALUES (?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          record_json = excluded.record_json,
          updated_at_ms = excluded.updated_at_ms
      `).run(record.name, JSON.stringify(record), record.updatedAtMs);
        });
    }
    async delete(name) {
        this.withDb((db) => {
            db.prepare('DELETE FROM local_runtime_agents WHERE name = ?').run(name);
        });
    }
    async list() {
        return this.withDb((db) => db
            .prepare('SELECT record_json FROM local_runtime_agents ORDER BY updated_at_ms DESC')
            .all()
            .flatMap((row) => {
            const record = parseJson(row.record_json);
            return record ? [record] : [];
        }));
    }
    withDb(fn) {
        return withLocalRuntimeDb(this.dataDir, fn);
    }
}
export class SqliteLocalMessageStore {
    dataDir;
    constructor(dataDir) {
        this.dataDir = dataDir;
    }
    async initSession(sessionId) {
        // Seed a ready/empty asset index state so subsequent hooked writes keep
        // the session asset index current without a lazy full scan.
        this.withDb((db) => {
            initSessionAssetIndexStateInTransaction(db, sessionId);
        });
    }
    async deleteSession(sessionId) {
        this.withDb((db) => {
            db.prepare('DELETE FROM local_runtime_messages WHERE session_id = ?').run(sessionId);
            db.prepare('DELETE FROM local_runtime_message_rows WHERE session_id = ?').run(sessionId);
            db.prepare('DELETE FROM local_runtime_message_row_migrations WHERE session_id = ?').run(sessionId);
            db.prepare('DELETE FROM local_runtime_pi_history_rows WHERE session_id = ?').run(sessionId);
            db.prepare('DELETE FROM local_runtime_pi_history_row_migrations WHERE session_id = ?').run(sessionId);
            deleteSessionAssetDataInTransaction(db, sessionId);
        });
    }
    async getDisplayMessages(sessionId) {
        return (await this.listDisplayMessages(sessionId)).messages;
    }
    async listDisplayMessages(sessionId, opts) {
        return this.withDb((db) => {
            backfillDisplayMessageRowsIfNeeded(db, sessionId);
            return listDisplayMessageRows(db, sessionId, opts);
        });
    }
    async listRecentDisplayMessages(sessionId, opts) {
        return this.withDb((db) => {
            backfillDisplayMessageRowsIfNeeded(db, sessionId);
            return listRecentDisplayMessageRows(db, sessionId, opts);
        });
    }
    async setDisplayMessages(sessionId, messages) {
        this.withDb((db) => {
            runInTransaction(db, () => {
                replaceDisplayMessageRowsInTransaction(db, sessionId, cloneJson(messages));
                markDisplayMessageRowsBackfilled(db, sessionId);
                clearLegacyDisplayMessagesBlob(db, sessionId);
                rebuildSessionAssetsInTransaction(db, sessionId);
            });
        });
    }
    async upsertDisplayMessage(sessionId, message) {
        this.withDb((db) => {
            runInTransaction(db, () => {
                backfillDisplayMessageRowsIfNeededInTransaction(db, sessionId);
                const normalized = upsertDisplayMessageRow(db, sessionId, cloneJson(message));
                indexDisplayMessageAssetsInTransaction(db, sessionId, {
                    msgId: normalized.msgId,
                    role: normalized.role,
                    createdAtMs: normalized.createdAtMs,
                    msgContent: typeof message.msg_content === 'string' ? message.msg_content : '',
                });
                advanceSessionAssetIndexStateInTransaction(db, sessionId);
            });
        });
    }
    async appendDisplayMessages(sessionId, messages, opts) {
        if (messages.length === 0) {
            // A `replaceExisting` first batch that happens to be empty must still
            // clear the session so the streamed import can produce an empty result
            // without leaking stale rows.
            if (opts?.replaceExisting) {
                this.withDb((db) => {
                    runInTransaction(db, () => {
                        replaceDisplayMessageRowsInTransaction(db, sessionId, []);
                        markDisplayMessageRowsBackfilled(db, sessionId);
                        clearLegacyDisplayMessagesBlob(db, sessionId);
                        rebuildSessionAssetsInTransaction(db, sessionId);
                    });
                });
            }
            return;
        }
        this.withDb((db) => {
            runInTransaction(db, () => {
                const replaceExisting = opts?.replaceExisting === true;
                if (replaceExisting) {
                    db.prepare('DELETE FROM local_runtime_message_rows WHERE session_id = ?').run(sessionId);
                    clearSessionAssetRowsInTransaction(db, sessionId);
                }
                else {
                    backfillDisplayMessageRowsIfNeededInTransaction(db, sessionId);
                }
                for (const message of messages) {
                    const normalized = upsertDisplayMessageRow(db, sessionId, message);
                    indexDisplayMessageAssetsInTransaction(db, sessionId, {
                        msgId: normalized.msgId,
                        role: normalized.role,
                        createdAtMs: normalized.createdAtMs,
                        msgContent: typeof message.msg_content === 'string' ? message.msg_content : '',
                    });
                }
                // Match `setDisplayMessages` bookkeeping so a streamed import ends in the
                // exact same persisted state as a single full write: the rows are
                // authoritative (backfilled), the legacy display blob is dropped, and
                // the derived session-asset index is advanced. These are idempotent, so
                // running them on every batch keeps each committed batch self-consistent
                // (a crash between batches leaves a valid prefix, not a half-written
                // transaction).
                markDisplayMessageRowsBackfilled(db, sessionId);
                clearLegacyDisplayMessagesBlob(db, sessionId);
                if (replaceExisting) {
                    markSessionAssetIndexReadyInTransaction(db, sessionId);
                }
                else {
                    advanceSessionAssetIndexStateInTransaction(db, sessionId);
                }
            });
        });
    }
    async deleteDisplayMessagesByIds(sessionId, msgIds) {
        if (msgIds.length === 0)
            return;
        this.withDb((db) => {
            runInTransaction(db, () => {
                backfillDisplayMessageRowsIfNeededInTransaction(db, sessionId);
                const stmt = db.prepare('DELETE FROM local_runtime_message_rows WHERE session_id = ? AND msg_id = ?');
                for (const msgId of msgIds) {
                    stmt.run(sessionId, msgId);
                }
                deleteSessionAssetRowsForMessagesInTransaction(db, sessionId, msgIds);
            });
        });
    }
    async getPiHistory(sessionId) {
        return this.withDb((db) => {
            backfillPiHistoryRowsIfNeeded(db, sessionId);
            return listPiHistoryRows(db, sessionId);
        });
    }
    async setPiHistory(sessionId, messages) {
        this.withDb((db) => {
            runInTransaction(db, () => {
                backfillPiHistoryRowsIfNeededInTransaction(db, sessionId);
                replacePiHistoryRowsInTransaction(db, sessionId, cloneJson(messages));
                markPiHistoryRowsBackfilled(db, sessionId);
                clearLegacyPiHistoryBlob(db, sessionId);
            });
        });
    }
    async appendPiHistory(sessionId, messages) {
        if (messages.length === 0)
            return;
        this.withDb((db) => {
            runInTransaction(db, () => {
                backfillPiHistoryRowsIfNeededInTransaction(db, sessionId);
                appendPiHistoryRows(db, sessionId, cloneJson(messages));
            });
        });
    }
    withDb(fn) {
        return withLocalRuntimeDb(this.dataDir, fn);
    }
}
export class SqliteLocalQueueStore {
    dataDir;
    constructor(dataDir) {
        this.dataDir = dataDir;
    }
    async list(sessionId) {
        return this.withDb((db) => {
            backfillQueueRowsIfNeeded(db, sessionId);
            return listQueueRows(db, sessionId);
        });
    }
    async replaceSession(sessionId, items) {
        this.withDb((db) => {
            runInTransaction(db, () => {
                backfillQueueRowsIfNeededInTransaction(db, sessionId);
                replaceQueueRowsInTransaction(db, sessionId, cloneJson(items));
                markQueueRowsBackfilled(db, sessionId);
            });
        });
    }
    async deleteSession(sessionId) {
        this.withDb((db) => {
            db.prepare('DELETE FROM local_runtime_queues WHERE session_id = ?').run(sessionId);
            db.prepare('DELETE FROM local_runtime_queue_items WHERE session_id = ?').run(sessionId);
            db.prepare('DELETE FROM local_runtime_queue_row_migrations WHERE session_id = ?').run(sessionId);
        });
    }
    withDb(fn) {
        return withLocalRuntimeDb(this.dataDir, fn);
    }
}
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
export class SqliteLocalTurnDiffStore {
    dataDir;
    constructor(dataDir) {
        this.dataDir = dataDir;
    }
    async createTurn(input) {
        this.withDb((db) => {
            db.prepare(`
        INSERT OR IGNORE INTO local_runtime_turn_diff_journal
          (journal_id, row_type, turn_id, session_id, agent_name, workspace_dir,
           turn_status, created_at_ms)
        VALUES
          (?, 'turn', ?, ?, ?, ?, 'pending', ?)
      `).run(turnJournalId(input.sessionId, input.turnId), input.turnId, input.sessionId, input.agentName, input.workspaceDir, Date.now());
        });
    }
    async getPendingTurn(sessionId) {
        return this.withDb((db) => readTurnDiffJournalTurnRow(db
            .prepare(`
            SELECT journal_id, row_type, turn_id, session_id, agent_name, workspace_dir,
                   turn_status, created_at_ms, finalized_at_ms
            FROM local_runtime_turn_diff_journal
            WHERE row_type = 'turn'
              AND session_id = ?
              AND turn_status = 'pending'
            ORDER BY created_at_ms ASC
            LIMIT 1
          `)
            .get(sessionId)));
    }
    async createToolCapture(input) {
        return this.withDb((db) => {
            const result = db
                .prepare(`
          INSERT OR IGNORE INTO local_runtime_turn_diff_journal
            (journal_id, row_type, turn_id, session_id, tool_call_id, tool_name, sequence,
             paths_json, before_json, after_json, tool_status, ambiguity_reason, created_at_ms)
          VALUES
            (?, 'tool', ?, ?, ?, ?,
             COALESCE(
               (SELECT MAX(sequence) + 1
                FROM local_runtime_turn_diff_journal
                WHERE session_id = ? AND turn_id = ? AND row_type = 'tool'),
               1
             ),
             ?, ?, '[]', 'started', ?, ?)
        `)
                .run(input.captureId, input.turnId, input.sessionId, input.toolCallId, input.toolName, input.sessionId, input.turnId, JSON.stringify(cloneJson(input.paths)), JSON.stringify(cloneJson(input.before)), input.ambiguityReason ?? null, Date.now());
            return numericOrZero(result.changes) > 0;
        });
    }
    async completeToolCapture(input) {
        return this.withDb((db) => {
            const result = db
                .prepare(`
          UPDATE local_runtime_turn_diff_journal
          SET after_json = ?, tool_status = 'completed', completed_at_ms = ?
          WHERE row_type = 'tool'
            AND turn_id = ?
            AND session_id = ?
            AND tool_call_id = ?
            AND tool_status = 'started'
        `)
                .run(JSON.stringify(cloneJson(input.after)), Date.now(), input.turnId, input.sessionId, input.toolCallId);
            return numericOrZero(result.changes) > 0;
        });
    }
    async markToolCaptureAmbiguous(input) {
        this.withDb((db) => {
            const now = Date.now();
            db.prepare(`
        INSERT OR IGNORE INTO local_runtime_turn_diff_journal
          (journal_id, row_type, turn_id, session_id, tool_call_id, tool_name, sequence,
           paths_json, before_json, after_json, tool_status, ambiguity_reason, created_at_ms,
           completed_at_ms)
        VALUES
          (?, 'tool', ?, ?, ?, ?,
           COALESCE(
             (SELECT MAX(sequence) + 1
              FROM local_runtime_turn_diff_journal
              WHERE session_id = ? AND turn_id = ? AND row_type = 'tool'),
             1
           ),
           ?, ?, '[]', 'ambiguous', ?, ?, ?)
      `).run(input.captureId, input.turnId, input.sessionId, input.toolCallId, input.toolName, input.sessionId, input.turnId, JSON.stringify(cloneJson(input.paths ?? [])), JSON.stringify(cloneJson(input.before ?? [])), input.reason, now, now);
            db.prepare(`
        UPDATE local_runtime_turn_diff_journal
        SET tool_status = 'ambiguous',
            ambiguity_reason = ?,
            completed_at_ms = ?
        WHERE row_type = 'tool'
          AND turn_id = ?
          AND session_id = ?
          AND tool_call_id = ?
      `).run(input.reason, now, input.turnId, input.sessionId, input.toolCallId);
        });
    }
    async getStartedToolCapture(turnId, sessionId, toolCallId) {
        return this.withDb((db) => readTurnDiffToolCaptureRow(db
            .prepare(`
            SELECT journal_id, row_type, turn_id, session_id, tool_call_id, tool_name,
                   sequence, paths_json, before_json, after_json, tool_status,
                   ambiguity_reason, created_at_ms, completed_at_ms
            FROM local_runtime_turn_diff_journal
            WHERE row_type = 'tool'
              AND turn_id = ?
              AND session_id = ?
              AND tool_call_id = ?
              AND tool_status = 'started'
            LIMIT 1
          `)
            .get(turnId, sessionId, toolCallId)));
    }
    async listCompletedToolCaptures(sessionId, turnId) {
        return this.withDb((db) => db
            .prepare(`
            SELECT journal_id, row_type, turn_id, session_id, tool_call_id, tool_name,
                   sequence, paths_json, before_json, after_json, tool_status,
                   ambiguity_reason, created_at_ms, completed_at_ms
            FROM local_runtime_turn_diff_journal
            WHERE row_type = 'tool'
              AND session_id = ?
              AND turn_id = ?
              AND tool_status IN ('completed', 'ambiguous')
            ORDER BY sequence ASC, created_at_ms ASC
          `)
            .all(sessionId, turnId).flatMap((row) => {
            const capture = readTurnDiffToolCaptureRow(row);
            return capture ? [capture] : [];
        }));
    }
    async markTurnFinalized(sessionId, turnId, status) {
        this.withDb((db) => {
            db.prepare(`
        UPDATE local_runtime_turn_diff_journal
        SET turn_status = ?, finalized_at_ms = ?
        WHERE row_type = 'turn'
          AND session_id = ?
          AND turn_id = ?
      `).run(status, Date.now(), sessionId, turnId);
        });
    }
    async markOtherPendingTurnsFinalized(sessionId, keepTurnId, status) {
        this.withDb((db) => {
            db.prepare(`
        UPDATE local_runtime_turn_diff_journal
        SET turn_status = ?, finalized_at_ms = ?
        WHERE row_type = 'turn'
          AND session_id = ?
          AND turn_id != ?
          AND turn_status = 'pending'
      `).run(status, Date.now(), sessionId, keepTurnId);
        });
    }
    async upsert(record) {
        this.withDb((db) => {
            const updatedAtMs = record.updatedAtMs ?? record.capturedAtMs;
            db.prepare(`
        INSERT INTO local_runtime_turn_diffs (
          change_set_id, session_id, agent_name, turn_id, assistant_message_id, workspace_dir,
          captured_at_ms, updated_at_ms, status, file_changes_json, undo_json, undoable,
          raw_diff, reverted_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, turn_id) DO UPDATE SET
          change_set_id = excluded.change_set_id,
          agent_name = excluded.agent_name,
          assistant_message_id = excluded.assistant_message_id,
          workspace_dir = excluded.workspace_dir,
          captured_at_ms = excluded.captured_at_ms,
          updated_at_ms = excluded.updated_at_ms,
          status = excluded.status,
          file_changes_json = excluded.file_changes_json,
          undo_json = excluded.undo_json,
          undoable = excluded.undoable,
          raw_diff = excluded.raw_diff,
          reverted_at_ms = excluded.reverted_at_ms
      `).run(record.changeSetId, record.sessionId, record.agentName ?? null, record.turnId, record.assistantMessageId ?? null, record.workspaceDir, record.capturedAtMs, updatedAtMs, record.status, JSON.stringify(cloneJson(record.fileChanges)), JSON.stringify(cloneJson(record.undo ?? [])), record.undoable ? 1 : 0, record.rawDiff ?? null, record.revertedAt ?? null);
        });
    }
    async getByTurn(sessionId, turnId) {
        return this.withDb((db) => readTurnDiffRow(db
            .prepare(`
            SELECT * FROM local_runtime_turn_diffs
            WHERE session_id = ? AND turn_id = ?
          `)
            .get(sessionId, turnId)));
    }
    async getByAssistantMessage(sessionId, assistantMessageId) {
        return this.withDb((db) => readTurnDiffRow(db
            .prepare(`
            SELECT * FROM local_runtime_turn_diffs
            WHERE session_id = ? AND assistant_message_id = ?
            ORDER BY captured_at_ms DESC
            LIMIT 1
          `)
            .get(sessionId, assistantMessageId)));
    }
    async latestForSession(sessionId) {
        return this.withDb((db) => readTurnDiffRow(db
            .prepare(`
            SELECT * FROM local_runtime_turn_diffs
            WHERE session_id = ?
            ORDER BY captured_at_ms DESC, change_set_id DESC
            LIMIT 1
          `)
            .get(sessionId)));
    }
    async getByChangeSetId(sessionId, changeSetId) {
        return this.withDb((db) => readTurnDiffRow(db
            .prepare(`
            SELECT * FROM local_runtime_turn_diffs
            WHERE session_id = ? AND change_set_id = ?
          `)
            .get(sessionId, changeSetId)));
    }
    async listBySession(sessionId) {
        return this.withDb((db) => db
            .prepare(`
            SELECT * FROM local_runtime_turn_diffs
            WHERE session_id = ?
            ORDER BY captured_at_ms ASC, change_set_id ASC
          `)
            .all(sessionId).flatMap((row) => {
            const record = readTurnDiffRow(row);
            return record ? [record] : [];
        }));
    }
    /** Navigation only needs paths; keep patches and undo contents inside SQLite. */
    async listFilePathsBySession(sessionId) {
        return this.withDb((db) => db
            .prepare(`
            SELECT assistant_message_id,
              (
                SELECT json_group_array(json_extract(item.value, '$.file'))
                FROM json_each(
                  CASE WHEN json_valid(file_changes_json) THEN file_changes_json ELSE '[]' END
                ) AS item
                WHERE item.type = 'object' AND json_type(item.value, '$.file') = 'text'
              ) AS file_paths_json
            FROM local_runtime_turn_diffs
            WHERE session_id = ? AND session_id != ''
              AND change_set_id != '' AND turn_id != '' AND workspace_dir != ''
            ORDER BY captured_at_ms ASC, change_set_id ASC
          `)
            .all(sessionId).map((row) => ({
            ...(row.assistant_message_id ? { assistantMessageId: row.assistant_message_id } : {}),
            filePaths: JSON.parse(row.file_paths_json),
        })));
    }
    async updateStatus(sessionId, changeSetId, status, revertedAt) {
        return this.withDb((db) => {
            db.prepare(`
        UPDATE local_runtime_turn_diffs
        SET status = ?, reverted_at_ms = ?, updated_at_ms = ?
        WHERE session_id = ? AND change_set_id = ?
      `).run(status, revertedAt ?? null, Date.now(), sessionId, changeSetId);
            return readTurnDiffRow(db
                .prepare(`
            SELECT * FROM local_runtime_turn_diffs
            WHERE session_id = ? AND change_set_id = ?
          `)
                .get(sessionId, changeSetId));
        });
    }
    async getRewindOperation(operationId) {
        return this.withDb((db) => readTurnDiffRewindOperation(db
            .prepare(`SELECT operation_id, session_id, plan_json, receipt_json
             FROM local_runtime_turn_diff_rewind_operations
             WHERE operation_id = ?`)
            .get(operationId)));
    }
    async putRewindPlan(plan) {
        this.withDb((db) => {
            const encoded = JSON.stringify(plan);
            const inserted = db
                .prepare(`INSERT OR IGNORE INTO local_runtime_turn_diff_rewind_operations
             (operation_id, session_id, plan_json, receipt_json, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, NULL, ?, ?)`)
                .run(plan.operationId, plan.sessionId, encoded, Date.now(), Date.now());
            if (numericOrZero(inserted.changes) > 0)
                return;
            const existing = db
                .prepare(`SELECT session_id, plan_json
           FROM local_runtime_turn_diff_rewind_operations
           WHERE operation_id = ?`)
                .get(plan.operationId);
            if (existing?.session_id !== plan.sessionId || existing.plan_json !== encoded) {
                throw new Error(`Turn diff rewind operation identity conflict: ${plan.operationId}`);
            }
        });
    }
    async putRewindReceipt(operationId, receipt) {
        this.withDb((db) => {
            const updated = db
                .prepare(`UPDATE local_runtime_turn_diff_rewind_operations
           SET receipt_json = COALESCE(receipt_json, ?), updated_at_ms = ?
           WHERE operation_id = ?`)
                .run(JSON.stringify(receipt), Date.now(), operationId);
            if (numericOrZero(updated.changes) === 0) {
                throw new Error(`Turn diff rewind plan is missing: ${operationId}`);
            }
        });
    }
    async pruneExpired(cutoffMs, batchSize) {
        return this.withDb((db) => pruneExpiredTurnDiffs(db, cutoffMs, batchSize));
    }
    async deleteTurns(sessionId, turnIds) {
        if (turnIds.length === 0)
            return;
        this.withDb((db) => {
            const placeholders = turnIds.map(() => '?').join(', ');
            const remove = () => {
                db.prepare(`DELETE FROM local_runtime_turn_diffs
           WHERE session_id = ? AND turn_id IN (${placeholders})`).run(sessionId, ...turnIds);
                db.prepare(`DELETE FROM local_runtime_turn_diff_journal
           WHERE session_id = ? AND turn_id IN (${placeholders})`).run(sessionId, ...turnIds);
            };
            if (db.transaction)
                db.transaction(remove)();
            else
                remove();
        });
    }
    async deleteSession(sessionId) {
        this.withDb((db) => {
            db.prepare('DELETE FROM local_runtime_turn_diffs WHERE session_id = ?').run(sessionId);
            db.prepare('DELETE FROM local_runtime_turn_diff_journal WHERE session_id = ?').run(sessionId);
            db.prepare('DELETE FROM local_runtime_turn_diff_rewind_operations WHERE session_id = ?').run(sessionId);
        });
    }
    withDb(fn) {
        return withLocalRuntimeDb(this.dataDir, fn);
    }
}
export class SqliteLocalCommunicationMessageStore {
    dataDir;
    constructor(dataDir) {
        this.dataDir = dataDir;
    }
    async append(record) {
        this.withDb((db) => {
            db.prepare(`
        INSERT INTO local_runtime_communication_messages (
          message_id, from_session, to_session, command, content, status, error, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(message_id) DO UPDATE SET
          from_session = excluded.from_session,
          to_session = excluded.to_session,
          command = excluded.command,
          content = excluded.content,
          status = excluded.status,
          error = excluded.error,
          created_at_ms = excluded.created_at_ms
      `).run(record.messageId, record.fromSession, record.toSession, record.command, record.content, record.status, record.error ?? null, record.createdAtMs);
        });
    }
    async list(opts) {
        return this.withDb((db) => {
            const where = ['1 = 1'];
            const params = [];
            if (opts?.fromSession) {
                where.push('from_session = ?');
                params.push(opts.fromSession);
            }
            if (opts?.toSession) {
                where.push('to_session = ?');
                params.push(opts.toSession);
            }
            if (opts?.status) {
                where.push('status = ?');
                params.push(opts.status);
            }
            const limit = normalizePositiveInteger(opts?.limit) ?? 50;
            const rows = db
                .prepare(`
          SELECT * FROM local_runtime_communication_messages
          WHERE ${where.join(' AND ')}
          ORDER BY created_at_ms DESC, message_id DESC
          LIMIT ?
        `)
                .all(...params, limit);
            return rows.flatMap(readCommunicationMessageRow);
        });
    }
    async deleteSession(sessionId) {
        this.withDb((db) => {
            db.prepare(`
        DELETE FROM local_runtime_communication_messages
        WHERE from_session = ? OR to_session = ?
      `).run(sessionId, sessionId);
        });
    }
    withDb(fn) {
        return withLocalRuntimeDb(this.dataDir, fn);
    }
}
// A single JS string cannot exceed V8's `String::kMaxLength` (0x1fffffe8,
// ~512MB). A legacy `local_runtime_messages` blob for a very heavy session
// (many tool outputs / image processing / PPT intermediate dumps) can grow
// past that ceiling. When better-sqlite3 materializes such a column value it
// throws `RangeError: Cannot create a string longer than 0x1fffffe8`. That
// RangeError previously propagated out of `listDisplayMessages` / `getPiHistory`
// (both re-run the legacy blob → rows backfill on every read until the
// migration marker exists), turning one oversized session into a permanent
// history-load 500. We now read each legacy blob column in isolation and treat
// an oversized/unreadable blob as unrecoverable: the caller drops the legacy
// merge, keeps whatever row-based data exists, and still marks the backfill
// done + clears the blob so subsequent reads never re-trip the ceiling.
function isStringLengthOverflowError(err) {
    return err instanceof RangeError && /string longer than/i.test(err.message);
}
function readLegacyBlobColumn(db, sessionId, column) {
    try {
        const row = db
            .prepare(`
      SELECT ${column} AS blob
      FROM local_runtime_messages
      WHERE session_id = ?
    `)
            .get(sessionId);
        return { messages: parseJson(row?.blob) ?? [], unrecoverable: false };
    }
    catch (err) {
        if (isStringLengthOverflowError(err)) {
            return { messages: [], unrecoverable: true };
        }
        throw err;
    }
}
function readLegacyDisplayMessagesBlob(db, sessionId) {
    return readLegacyBlobColumn(db, sessionId, 'display_messages_json');
}
function readLegacyPiHistoryBlob(db, sessionId) {
    return readLegacyBlobColumn(db, sessionId, 'pi_history_json');
}
function backfillDisplayMessageRowsIfNeeded(db, sessionId) {
    runInTransaction(db, () => backfillDisplayMessageRowsIfNeededInTransaction(db, sessionId));
}
// Exported for the session asset store: lazy indexing must scan real message
// rows, so the legacy blob → rows backfill has to run inside its transaction.
export function backfillDisplayMessageRowsIfNeededInTransaction(db, sessionId) {
    const row = db
        .prepare('SELECT 1 FROM local_runtime_message_row_migrations WHERE session_id = ? LIMIT 1')
        .get(sessionId);
    if (row)
        return;
    const legacy = readLegacyDisplayMessagesBlob(db, sessionId);
    const currentRows = listAllDisplayMessageRows(db, sessionId);
    // Oversized/unreadable legacy blob: keep only the row-based history so the
    // session stays loadable instead of throwing a RangeError on every read.
    replaceDisplayMessageRowsInTransaction(db, sessionId, legacy.unrecoverable
        ? currentRows.flatMap(readDisplayMessageRow)
        : mergeBackfilledDisplayMessages(legacy.messages, currentRows));
    markDisplayMessageRowsBackfilled(db, sessionId);
    clearLegacyDisplayMessagesBlob(db, sessionId);
}
function listDisplayMessageRows(db, sessionId, opts) {
    const limit = normalizeMessageLimit(opts?.limit);
    if (limit <= 0) {
        const rows = opts?.before
            ? selectDisplayMessageRowsBefore(db, sessionId, opts.before)
            : listAllDisplayMessageRows(db, sessionId);
        return { messages: rows.flatMap(readDisplayMessageRow), hasMore: false };
    }
    const before = opts?.before;
    let rows;
    if (before) {
        const cursorRow = db
            .prepare('SELECT id FROM local_runtime_message_rows WHERE session_id = ? AND msg_id = ?')
            .get(sessionId, before);
        rows = cursorRow?.id
            ? db
                .prepare(`
            SELECT data_json
            FROM local_runtime_message_rows
            WHERE session_id = ? AND id < ?
            ORDER BY id DESC
            LIMIT ?
          `)
                .all(sessionId, cursorRow.id, limit + 1)
            : selectLatestDisplayMessageRows(db, sessionId, limit + 1);
    }
    else {
        rows = selectLatestDisplayMessageRows(db, sessionId, limit + 1);
    }
    const hasMore = rows.length > limit;
    if (hasMore)
        rows.pop();
    rows.reverse();
    const messages = rows.flatMap(readDisplayMessageRow);
    return {
        messages,
        hasMore,
        ...(hasMore && messages[0]?.msg_id ? { nextCursor: messages[0].msg_id } : {}),
    };
}
// Mirrors the daemon SqliteMessageStore.getRecent statements: the role filter
// and the synthetic `<permission-response>` exclusion live in the SQL WHERE
// clause so `limit` counts matching rows, then rows come back chronological.
function listRecentDisplayMessageRows(db, sessionId, opts) {
    if (!Number.isFinite(opts.limit) || opts.limit <= 0)
        return [];
    const limit = Math.floor(opts.limit);
    const where = ['session_id = ?'];
    const params = [sessionId];
    if (opts.role) {
        where.push('role = ?');
        params.push(opts.role);
    }
    if (opts.excludePermissionResponses) {
        where.push('data_json NOT LIKE ?');
        params.push('%<permission-response>%');
    }
    const rows = db
        .prepare(`
      SELECT data_json
      FROM local_runtime_message_rows
      WHERE ${where.join(' AND ')}
      ORDER BY id DESC
      LIMIT ?
    `)
        .all(...params, limit);
    rows.reverse();
    return rows.flatMap(readDisplayMessageRow);
}
function listAllDisplayMessageRows(db, sessionId) {
    return db
        .prepare(`
      SELECT data_json
      FROM local_runtime_message_rows
      WHERE session_id = ?
      ORDER BY id ASC
    `)
        .all(sessionId);
}
function selectDisplayMessageRowsBefore(db, sessionId, before) {
    const cursorRow = db
        .prepare('SELECT id FROM local_runtime_message_rows WHERE session_id = ? AND msg_id = ?')
        .get(sessionId, before);
    if (!cursorRow?.id)
        return listAllDisplayMessageRows(db, sessionId);
    return db
        .prepare(`
      SELECT data_json
      FROM local_runtime_message_rows
      WHERE session_id = ? AND id < ?
      ORDER BY id ASC
    `)
        .all(sessionId, cursorRow.id);
}
function selectLatestDisplayMessageRows(db, sessionId, limit) {
    return db
        .prepare(`
      SELECT data_json
      FROM local_runtime_message_rows
      WHERE session_id = ?
      ORDER BY id DESC
      LIMIT ?
    `)
        .all(sessionId, limit);
}
function replaceDisplayMessageRowsInTransaction(db, sessionId, messages) {
    db.prepare('DELETE FROM local_runtime_message_rows WHERE session_id = ?').run(sessionId);
    for (const message of messages) {
        upsertDisplayMessageRow(db, sessionId, message);
    }
}
function mergeBackfilledDisplayMessages(legacyMessages, currentRows) {
    const currentMessages = currentRows.flatMap(readDisplayMessageRow);
    if (legacyMessages.length === 0)
        return currentMessages;
    const currentById = new Map();
    for (const message of currentMessages) {
        const msgId = message.msg_id;
        if (typeof msgId === 'string' && msgId)
            currentById.set(msgId, message);
    }
    const merged = [];
    for (const legacyMessage of legacyMessages) {
        const msgId = legacyMessage.msg_id;
        if (typeof msgId === 'string' && currentById.has(msgId)) {
            merged.push(currentById.get(msgId));
            currentById.delete(msgId);
        }
        else {
            merged.push(legacyMessage);
        }
    }
    for (const currentMessage of currentMessages) {
        const msgId = currentMessage.msg_id;
        if (typeof msgId === 'string' && msgId && !currentById.has(msgId))
            continue;
        merged.push(currentMessage);
        if (typeof msgId === 'string' && msgId)
            currentById.delete(msgId);
    }
    return merged;
}
function markDisplayMessageRowsBackfilled(db, sessionId) {
    db.prepare(`
    INSERT INTO local_runtime_message_row_migrations (session_id, display_rows_backfilled_at_ms)
    VALUES (?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      display_rows_backfilled_at_ms = excluded.display_rows_backfilled_at_ms
  `).run(sessionId, Date.now());
}
function backfillPiHistoryRowsIfNeeded(db, sessionId) {
    runInTransaction(db, () => backfillPiHistoryRowsIfNeededInTransaction(db, sessionId));
}
// Exported (mirrors `backfillDisplayMessageRowsIfNeededInTransaction`) so the
// oversized-legacy-blob degradation path can be unit-tested with an injected
// database that reproduces the V8 string-length RangeError.
export function backfillPiHistoryRowsIfNeededInTransaction(db, sessionId) {
    const row = db
        .prepare('SELECT 1 FROM local_runtime_pi_history_row_migrations WHERE session_id = ? LIMIT 1')
        .get(sessionId);
    if (row)
        return;
    const legacy = readLegacyPiHistoryBlob(db, sessionId);
    const currentHistory = listPiHistoryRows(db, sessionId);
    // Oversized/unreadable legacy pi-history blob: keep only the row-based
    // history so pi-history loads (resume, POST /message) stay non-fatal.
    replacePiHistoryRowsInTransaction(db, sessionId, legacy.unrecoverable ? currentHistory : [...legacy.messages, ...currentHistory]);
    markPiHistoryRowsBackfilled(db, sessionId);
    clearLegacyPiHistoryBlob(db, sessionId);
}
function listPiHistoryRows(db, sessionId) {
    const rows = db
        .prepare(`
      SELECT data_json
      FROM local_runtime_pi_history_rows
      WHERE session_id = ?
      ORDER BY id ASC
    `)
        .all(sessionId);
    return rows.flatMap(readPiHistoryRow);
}
function replacePiHistoryRowsInTransaction(db, sessionId, messages) {
    db.prepare('DELETE FROM local_runtime_pi_history_rows WHERE session_id = ?').run(sessionId);
    appendPiHistoryRows(db, sessionId, messages);
}
function appendPiHistoryRows(db, sessionId, messages) {
    for (const message of messages) {
        appendPiHistoryRow(db, sessionId, message);
    }
}
function appendPiHistoryRow(db, sessionId, message) {
    const normalized = normalizePiHistoryMessage(message);
    db.prepare(`
    INSERT INTO local_runtime_pi_history_rows (
      session_id,
      role,
      created_at_ms,
      data_json
    ) VALUES (?, ?, ?, ?)
  `).run(sessionId, normalized.role, normalized.createdAtMs, normalized.dataJson);
}
function markPiHistoryRowsBackfilled(db, sessionId) {
    db.prepare(`
    INSERT INTO local_runtime_pi_history_row_migrations (session_id, history_rows_backfilled_at_ms)
    VALUES (?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      history_rows_backfilled_at_ms = excluded.history_rows_backfilled_at_ms
  `).run(sessionId, Date.now());
}
function backfillQueueRowsIfNeeded(db, sessionId) {
    runInTransaction(db, () => backfillQueueRowsIfNeededInTransaction(db, sessionId));
}
function backfillQueueRowsIfNeededInTransaction(db, sessionId) {
    const row = db
        .prepare('SELECT 1 FROM local_runtime_queue_row_migrations WHERE session_id = ? LIMIT 1')
        .get(sessionId);
    if (row)
        return;
    const legacyQueue = readQueueBlob(db, sessionId);
    const currentQueue = listQueueRows(db, sessionId);
    replaceQueueRowsInTransaction(db, sessionId, [...legacyQueue, ...currentQueue]);
    markQueueRowsBackfilled(db, sessionId);
    clearLegacyQueueBlob(db, sessionId);
}
function readQueueBlob(db, sessionId) {
    const row = db
        .prepare('SELECT items_json FROM local_runtime_queues WHERE session_id = ?')
        .get(sessionId);
    return parseJson(row?.items_json) ?? [];
}
function listQueueRows(db, sessionId) {
    const rows = db
        .prepare(`
      SELECT data_json
      FROM local_runtime_queue_items
      WHERE session_id = ?
      ORDER BY id ASC
    `)
        .all(sessionId);
    return rows.flatMap(readQueueItemRow);
}
function replaceQueueRowsInTransaction(db, sessionId, items) {
    db.prepare('DELETE FROM local_runtime_queue_items WHERE session_id = ?').run(sessionId);
    for (const item of items) {
        insertQueueRow(db, sessionId, item);
    }
}
function insertQueueRow(db, sessionId, item) {
    const normalized = normalizeQueueItem(item);
    db.prepare(`
    INSERT INTO local_runtime_queue_items (
      session_id,
      item_id,
      status,
      created_at_ms,
      data_json
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id, item_id) DO UPDATE SET
      status = excluded.status,
      created_at_ms = excluded.created_at_ms,
      data_json = excluded.data_json
  `).run(sessionId, normalized.itemId, normalized.status, normalized.createdAtMs, normalized.dataJson);
}
function markQueueRowsBackfilled(db, sessionId) {
    db.prepare(`
    INSERT INTO local_runtime_queue_row_migrations (session_id, queue_rows_backfilled_at_ms)
    VALUES (?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      queue_rows_backfilled_at_ms = excluded.queue_rows_backfilled_at_ms
  `).run(sessionId, Date.now());
}
function clearLegacyDisplayMessagesBlob(db, sessionId) {
    db.prepare(`
    UPDATE local_runtime_messages
    SET display_messages_json = '[]'
    WHERE session_id = ?
  `).run(sessionId);
    deleteEmptyLegacyMessageBlobRow(db, sessionId);
}
function clearLegacyPiHistoryBlob(db, sessionId) {
    db.prepare(`
    UPDATE local_runtime_messages
    SET pi_history_json = '[]'
    WHERE session_id = ?
  `).run(sessionId);
    deleteEmptyLegacyMessageBlobRow(db, sessionId);
}
function deleteEmptyLegacyMessageBlobRow(db, sessionId) {
    db.prepare(`
    DELETE FROM local_runtime_messages
    WHERE session_id = ?
      AND display_messages_json = '[]'
      AND pi_history_json = '[]'
  `).run(sessionId);
}
function clearLegacyQueueBlob(db, sessionId) {
    db.prepare('DELETE FROM local_runtime_queues WHERE session_id = ?').run(sessionId);
}
function runInTransaction(db, fn) {
    if (db.transaction) {
        db.transaction(fn)();
        return;
    }
    fn();
}
function upsertDisplayMessageRow(db, sessionId, message) {
    const normalized = normalizeDisplayMessage(message);
    db.prepare(`
    INSERT INTO local_runtime_message_rows (
      session_id,
      msg_id,
      role,
      turn_id,
      created_at_ms,
      data_json
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, msg_id) DO UPDATE SET
      role = excluded.role,
      turn_id = excluded.turn_id,
      created_at_ms = excluded.created_at_ms,
      data_json = excluded.data_json
  `).run(sessionId, normalized.msgId, normalized.role, normalized.turnId, normalized.createdAtMs, normalized.dataJson);
    return normalized;
}
function normalizeDisplayMessage(message) {
    const record = message;
    const createdAtMs = normalizeTimestamp(record.timestamp ?? record.created_at);
    const msgId = String(record.msg_id || `msg-${createdAtMs}-${stableMessageSuffix(record)}`);
    const dataJson = JSON.stringify({ ...record, msg_id: msgId });
    return {
        msgId,
        role: typeof record.role === 'string' ? record.role : null,
        turnId: typeof record.turnId === 'string'
            ? record.turnId
            : typeof record.meta?.turnId === 'string'
                ? record.meta.turnId
                : null,
        createdAtMs,
        dataJson,
    };
}
function readDisplayMessageRow(row) {
    const parsed = parseJson(row.data_json);
    return parsed ? [parsed] : [];
}
function normalizePiHistoryMessage(message) {
    const record = message;
    return {
        role: typeof record.role === 'string' ? record.role : null,
        createdAtMs: normalizeTimestamp(record.timestamp ?? record.created_at),
        dataJson: JSON.stringify(record),
    };
}
function readPiHistoryRow(row) {
    const parsed = parseJson(row.data_json);
    return parsed ? [parsed] : [];
}
function normalizeQueueItem(item) {
    const record = item;
    const itemId = typeof record.itemId === 'string' && record.itemId
        ? record.itemId
        : `queue-${normalizeTimestamp(record.createdAt)}-${stableMessageSuffix(record)}`;
    const createdAtMs = normalizeTimestamp(record.createdAt);
    const normalized = { ...record, itemId, createdAt: createdAtMs };
    return {
        itemId,
        status: typeof record.status === 'string' ? record.status : null,
        createdAtMs,
        dataJson: JSON.stringify(normalized),
    };
}
function readQueueItemRow(row) {
    const parsed = parseJson(row.data_json);
    return parsed ? [parsed] : [];
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
function normalizeTurnDiffToolStatus(status) {
    return status === 'completed' ||
        status === 'ambiguous' ||
        status === 'failed' ||
        status === 'started'
        ? status
        : 'failed';
}
function normalizeTurnDiffTurnStatus(status) {
    return status === 'finalized' ||
        status === 'empty' ||
        status === 'failed' ||
        status === 'superseded'
        ? status
        : 'pending';
}
function readJsonArray(raw) {
    const parsed = parseJson(raw ?? undefined);
    return Array.isArray(parsed) ? parsed : [];
}
function readTurnDiffJournalTurnRow(row) {
    if (!row?.turn_id || !row.session_id)
        return undefined;
    return {
        turnId: row.turn_id,
        sessionId: row.session_id,
        agentName: row.agent_name ?? '',
        workspaceDir: row.workspace_dir ?? '',
        createdAtMs: numericOrZero(row.created_at_ms),
        ...(typeof row.finalized_at_ms === 'number' ? { finalizedAtMs: row.finalized_at_ms } : {}),
        status: normalizeTurnDiffTurnStatus(row.turn_status),
    };
}
function readTurnDiffToolCaptureRow(row) {
    if (!row?.journal_id || !row.turn_id || !row.session_id || !row.tool_call_id)
        return undefined;
    return {
        captureId: row.journal_id,
        turnId: row.turn_id,
        sessionId: row.session_id,
        toolCallId: row.tool_call_id,
        toolName: row.tool_name ?? '',
        sequence: numericOrZero(row.sequence),
        paths: readJsonArray(row.paths_json),
        before: readJsonArray(row.before_json),
        after: readJsonArray(row.after_json),
        status: normalizeTurnDiffToolStatus(row.tool_status),
        ...(row.ambiguity_reason ? { ambiguityReason: row.ambiguity_reason } : {}),
        createdAtMs: numericOrZero(row.created_at_ms),
        ...(typeof row.completed_at_ms === 'number' ? { completedAtMs: row.completed_at_ms } : {}),
    };
}
function readTurnDiffRow(row) {
    if (!row?.change_set_id || !row.session_id || !row.turn_id || !row.workspace_dir) {
        return undefined;
    }
    const fileChanges = parseJson(row.file_changes_json) ?? [];
    const undo = readJsonArray(row.undo_json);
    const status = row.status === 'reverted' ? 'reverted' : 'active';
    return {
        changeSetId: row.change_set_id,
        sessionId: row.session_id,
        ...(row.agent_name ? { agentName: row.agent_name } : {}),
        turnId: row.turn_id,
        ...(row.assistant_message_id ? { assistantMessageId: row.assistant_message_id } : {}),
        workspaceDir: row.workspace_dir,
        capturedAtMs: numericOrZero(row.captured_at_ms),
        ...(typeof row.updated_at_ms === 'number' ? { updatedAtMs: row.updated_at_ms } : {}),
        status,
        fileChanges,
        undo,
        undoable: row.undoable === 1,
        ...(row.raw_diff ? { rawDiff: row.raw_diff } : {}),
        ...(typeof row.reverted_at_ms === 'number' ? { revertedAt: row.reverted_at_ms } : {}),
    };
}
function readTurnDiffRewindOperation(row) {
    if (!row?.operation_id || !row.session_id || !row.plan_json)
        return undefined;
    const plan = parseJson(row.plan_json);
    if (!plan || plan.operationId !== row.operation_id || plan.sessionId !== row.session_id) {
        throw new Error(`Invalid Turn diff rewind plan: ${row.operation_id}`);
    }
    const receipt = row.receipt_json
        ? parseJson(row.receipt_json)
        : undefined;
    return { plan, ...(receipt ? { receipt } : {}) };
}
function readCommunicationMessageRow(row) {
    const messageId = row.message_id;
    const fromSession = row.from_session;
    const toSession = row.to_session;
    const command = row.command;
    const status = row.status;
    if (!messageId ||
        !fromSession ||
        !toSession ||
        !command ||
        (status !== 'delivered' && status !== 'failed')) {
        return [];
    }
    return [
        {
            messageId,
            fromSession,
            toSession,
            command,
            content: row.content ?? '',
            status,
            ...(row.error ? { error: row.error } : {}),
            createdAtMs: numericOrZero(row.created_at_ms),
        },
    ];
}
function normalizeMessageLimit(limit) {
    if (!Number.isFinite(limit ?? 0))
        return 0;
    return Math.max(0, Math.floor(limit ?? 0));
}
function normalizePositiveInteger(value) {
    if (value === undefined || !Number.isFinite(value))
        return undefined;
    return Math.max(1, Math.floor(value));
}
function numericOrZero(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
function turnJournalId(sessionId, turnId) {
    return `turn:${sessionId}:${turnId}`;
}
function normalizeTimestamp(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string') {
        const numeric = Number(value);
        if (Number.isFinite(numeric))
            return numeric;
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return Date.now();
}
function stableMessageSuffix(value) {
    return Buffer.from(JSON.stringify(value)).toString('base64url').slice(0, 12);
}
function parseJson(raw) {
    if (!raw)
        return undefined;
    try {
        return JSON.parse(raw);
    }
    catch {
        return undefined;
    }
}
function normalizeScanLimit(value) {
    if (value === undefined || !Number.isFinite(value))
        return undefined;
    const normalized = Math.floor(value);
    return normalized > 0 ? normalized : undefined;
}
function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}
//# sourceMappingURL=sqlite-persistence.js.map