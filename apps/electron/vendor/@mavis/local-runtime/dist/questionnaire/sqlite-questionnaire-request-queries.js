import { withLocalRuntimeDb } from '../persistence/db.js';
import { isOwnedActionRequest, QUALIFIED_QUESTIONNAIRE_ROW_SELECT, QUESTIONNAIRE_ROW_SELECT, toCompatibleQuestionnaireRequestRecord, } from './sqlite-row-codec.js';
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
    async findLatestPendingBySession(sessionId, createdAtCutoff = Number.MIN_SAFE_INTEGER) {
        return this.withDb((db) => {
            const row = db
                .prepare(`
          SELECT ${QUESTIONNAIRE_ROW_SELECT}
          FROM questionnaire_requests
          WHERE session_id = ?
            AND status = 'pending'
            AND created_at >= ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1
        `)
                .get(sessionId, createdAtCutoff);
            return row ? toCompatibleQuestionnaireRequestRecord(row) : null;
        });
    }
    async findLatestBySession(sessionId) {
        return this.withDb((db) => {
            const row = db
                .prepare(`
          SELECT ${QUESTIONNAIRE_ROW_SELECT}
          FROM questionnaire_requests
          WHERE session_id = ?
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
              AND (
                status = 'pending'
                OR (status = 'answered' AND injected_at IS NULL)
              )
            LIMIT 1
          `)
            .get(sessionId)));
    }
    withDb(fn) {
        return withLocalRuntimeDb(this.dataDir, fn);
    }
}
//# sourceMappingURL=sqlite-questionnaire-request-queries.js.map