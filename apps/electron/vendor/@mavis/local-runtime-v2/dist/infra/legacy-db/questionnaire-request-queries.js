import { withLocalRuntimeDb } from './db.js';
import {} from './database-contracts.js';
import { isOwnedActionRequest, QUALIFIED_QUESTIONNAIRE_ROW_SELECT, QUESTIONNAIRE_ROW_SELECT, toCompatibleQuestionnaireRequestRecord, } from './questionnaire-row-codec.js';
/**
 * Row-level match for Plugin preparation cards over unqualified
 * `questionnaire_requests` columns (valid inside single-table or innermost
 * subquery scopes). Malformed request JSON never matches.
 */
export const PLUGIN_PREPARATION_ROW_SQL = "(CASE WHEN json_valid(request_json) = 1 THEN COALESCE(json_extract(request_json, '$.mode'), 'questionnaire') = 'plugin-preparation' ELSE 0 END)";
// Plugin preparation cards are inline suggestions: they never gate the session.
export const SESSION_GATING_PENDING_SQL = `(response_mode IS NULL AND NOT ${PLUGIN_PREPARATION_ROW_SQL})`;
export class SqliteQuestionnaireRequestQueries {
    dataDir;
    constructor(dataDir) {
        this.dataDir = dataDir;
    }
    async get(requestId) {
        return this.withDb((db) => {
            const row = db
                .prepare(`SELECT ${QUESTIONNAIRE_ROW_SELECT} FROM questionnaire_requests WHERE request_id = ?`)
                .get(requestId);
            return row ? toCompatibleQuestionnaireRequestRecord(row) : null;
        });
    }
    async getAll() {
        return this.withDb((db) => db
            .prepare(`
            SELECT ${QUALIFIED_QUESTIONNAIRE_ROW_SELECT}
            FROM questionnaire_requests qr
            INNER JOIN local_runtime_sessions s ON s.session_id = qr.session_id
            ORDER BY qr.created_at ASC, qr.rowid ASC
          `)
            .all().map(toCompatibleQuestionnaireRequestRecord));
    }
    async findAllPendingForRecovery() {
        return this.withDb((db) => db
            .prepare(`
            SELECT ${QUALIFIED_QUESTIONNAIRE_ROW_SELECT}
            FROM questionnaire_requests qr
            INNER JOIN local_runtime_sessions s ON s.session_id = qr.session_id
            WHERE qr.status = 'pending'
            ORDER BY qr.created_at DESC, qr.rowid DESC
          `)
            .all().map(toCompatibleQuestionnaireRequestRecord));
    }
    async findAnsweredPendingInject() {
        return this.withDb((db) => db
            .prepare(`
            SELECT ${QUALIFIED_QUESTIONNAIRE_ROW_SELECT}
            FROM questionnaire_requests qr
            INNER JOIN local_runtime_sessions s ON s.session_id = qr.session_id
            WHERE qr.status = 'answered'
              AND qr.answered_at IS NOT NULL
              AND qr.injected_at IS NULL
              AND json_valid(qr.request_json) = 1
            ORDER BY qr.answered_at ASC, qr.rowid ASC
          `)
            .all()
            .map(toCompatibleQuestionnaireRequestRecord)
            .filter((record) => !isOwnedActionRequest(record.request)));
    }
    async findOwnedActionsPendingCompletion() {
        return this.withDb((db) => db
            .prepare(`
            SELECT ${QUALIFIED_QUESTIONNAIRE_ROW_SELECT}
            FROM questionnaire_requests qr
            INNER JOIN local_runtime_sessions s ON s.session_id = qr.session_id
            WHERE qr.status IN ('answered', 'dismissed')
              AND qr.injected_at IS NULL
              AND json_valid(qr.request_json) = 1
            ORDER BY COALESCE(qr.answered_at, qr.dismissed_at, qr.created_at) ASC
          `)
            .all()
            .map(toCompatibleQuestionnaireRequestRecord)
            .filter((record) => isOwnedActionRequest(record.request)));
    }
    async findLatestPendingBySession(sessionId, createdAtCutoff = Number.MIN_SAFE_INTEGER, options = {}) {
        return this.withDb((db) => {
            const row = db
                .prepare(`
          SELECT ${QUESTIONNAIRE_ROW_SELECT}
          FROM questionnaire_requests
          WHERE session_id = ?
            AND status = 'pending'
            AND created_at >= ?
            AND ${options.legacyOnly ? SESSION_GATING_PENDING_SQL : `NOT ${PLUGIN_PREPARATION_ROW_SQL}`}
            ${options.excludeSkipped ? 'AND (response_mode IS NULL OR dismissed_at IS NULL)' : ''}
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1
        `)
                .get(sessionId, createdAtCutoff);
            return row ? toCompatibleQuestionnaireRequestRecord(row) : null;
        });
    }
    async findUnansweredV2BySession(sessionId, createdAtCutoff) {
        // Same 24h cutoff as the single `request`: an older pending row is about to
        // be expired and can no longer be answered.
        return this.withDb((db) => db
            .prepare(`
            SELECT ${QUESTIONNAIRE_ROW_SELECT}
            FROM questionnaire_requests
            WHERE session_id = ?
              AND status = 'pending'
              AND created_at >= ?
              AND response_mode IS NOT NULL
            ORDER BY created_at DESC, rowid DESC
          `)
            .all(sessionId, createdAtCutoff).map(toCompatibleQuestionnaireRequestRecord));
    }
    async findLatestBySession(sessionId) {
        // Goal guards only: v2 rows never carry Goal ownership and never replace a
        // legacy row, so they must not stand in for "the latest questionnaire";
        // neither do inline Plugin preparation cards.
        return this.withDb((db) => {
            const row = db
                .prepare(`
          SELECT ${QUESTIONNAIRE_ROW_SELECT}
          FROM questionnaire_requests
          WHERE session_id = ?
            AND ${SESSION_GATING_PENDING_SQL}
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1
        `)
                .get(sessionId);
            return row ? toCompatibleQuestionnaireRequestRecord(row) : null;
        });
    }
    async findLatestPlanReviewBySession(sessionId, createdAtCutoff = Number.MIN_SAFE_INTEGER) {
        return this.withDb((db) => {
            const row = db
                .prepare(`
          SELECT ${QUESTIONNAIRE_ROW_SELECT}
          FROM questionnaire_requests qr
          WHERE qr.session_id = ?
            AND (qr.status != 'pending' OR qr.created_at >= ?)
            AND CASE
              WHEN json_valid(qr.request_json) = 1 THEN
                json_extract(qr.request_json, '$.mode') = 'plan'
                  AND json_type(qr.request_json, '$.modePayload.planReview.markdown') = 'text'
                  AND json_type(qr.request_json, '$.modePayload.planReview.path') = 'text'
              ELSE 0
            END
          ORDER BY qr.created_at DESC, qr.request_id DESC
          LIMIT 1
        `)
                .get(sessionId, createdAtCutoff);
            return row ? toCompatibleQuestionnaireRequestRecord(row) : null;
        });
    }
    async hasUnresolvedBySession(sessionId) {
        return this.withDb((db) => Boolean(db
            .prepare(`
            SELECT 1 AS present
            FROM questionnaire_requests
            WHERE session_id = ?
              AND ${SESSION_GATING_PENDING_SQL}
              AND (
                status = 'pending'
                OR (status = 'answered' AND injected_at IS NULL)
              )
            LIMIT 1
          `)
            .get(sessionId)));
    }
    /** Every row of one owned mode in the session, oldest first, regardless of status. */
    async listByMode(sessionId, mode) {
        return this.withDb((db) => db
            .prepare(`
            SELECT ${QUESTIONNAIRE_ROW_SELECT}
            FROM questionnaire_requests
            WHERE session_id = ?
              AND CASE
                WHEN json_valid(request_json) = 1
                  THEN json_extract(request_json, '$.mode') = ?
                ELSE 0
              END
            ORDER BY created_at ASC, rowid ASC
          `)
            .all(sessionId, mode).map(toCompatibleQuestionnaireRequestRecord));
    }
    withDb(fn) {
        return withLocalRuntimeDb(this.dataDir, fn);
    }
}
//# sourceMappingURL=questionnaire-request-queries.js.map