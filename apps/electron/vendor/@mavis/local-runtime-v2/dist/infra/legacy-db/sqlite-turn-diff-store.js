import { withLocalRuntimeDb } from './db.js';
import {} from './database-contracts.js';
import { pruneExpiredTurnDiffs } from './turn-diff-retention.js';
import { cloneJson, numericOrZero, parseJson } from './sqlite-persistence-values.js';
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
        ...readTurnDiffRevertFields(row),
    };
}
function readTurnDiffRevertFields(row) {
    return {
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
function turnJournalId(sessionId, turnId) {
    return `turn:${sessionId}:${turnId}`;
}
//# sourceMappingURL=sqlite-turn-diff-store.js.map