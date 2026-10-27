import { markQuestionnaireInjected } from './sqlite-questionnaire-delivery.js';
import { runInImmediateTransaction, withLocalRuntimeDb, } from '../persistence/db.js';
import { isOwnedActionRequestJson, parseQuestionnaireOriginChannelContext, } from './sqlite-row-codec.js';
import { SqliteQuestionnaireRequestQueries } from './sqlite-questionnaire-request-queries.js';
import { deleteUnresolvedQuestionnairesForRewind, findUnresolvedQuestionnairesForRewind, } from './sqlite-questionnaire-rewind.js';
export class SqliteQuestionnaireRequestStore {
    dataDir;
    queries;
    constructor(dataDir) {
        this.dataDir = dataDir;
        this.queries = new SqliteQuestionnaireRequestQueries(dataDir);
    }
    async upsert(record) {
        this.withDb((db) => this.writeRecord(db, record));
    }
    async beginPendingWithPolicy(input) {
        return this.withDb((db) => runInImmediateTransaction(db, () => {
            const rows = db
                .prepare(`
            SELECT request_id, request_json, response_mode
            FROM questionnaire_requests
            WHERE session_id = ?
              AND status = 'pending'
              AND created_at >= ?
            ORDER BY created_at ASC, request_id ASC
          `)
                .all(input.record.sessionId, input.createdAtCutoff);
            // v2 rows (response_mode set) neither conflict with nor get replaced
            // by a new request: they stay answerable until answered or expired,
            // so an unanswered v2 question must not block a Plan card and a new
            // question must not retire it. Only legacy rows keep the one-pending
            // invariant. The retained ids are returned so the caller can log them.
            const pending = rows.filter((row) => row.response_mode == null);
            const retainedV2RequestIds = rows.flatMap((row) => row.response_mode != null && row.request_id ? [row.request_id] : []);
            if (input.policy === 'exclusive' && pending.length > 0) {
                return { status: 'pending-conflict' };
            }
            // Plan cards and v2 questionnaires do not affect each other in either
            // direction: a new v2 request is created next to a pending Plan card
            // and leaves it pending. A legacy request keeps the baseline 409.
            const creatingV2 = input.record.responseMode !== undefined;
            const ownedPending = pending.filter((row) => isOwnedActionRequestJson(row.request_json));
            if (input.policy === 'replaceable' && ownedPending.length > 0 && !creatingV2) {
                return { status: 'pending-conflict' };
            }
            const retainedOwnedRequestIds = ownedPending.flatMap((row) => row.request_id ? [row.request_id] : []);
            const supersededRequestIds = [];
            if (input.policy === 'replaceable') {
                const supersede = db.prepare(`
            UPDATE questionnaire_requests
            SET status = 'superseded'
            WHERE request_id = ? AND status = 'pending'
          `);
                for (const row of pending) {
                    // Only reachable for a v2 request: Plan cards stay pending, while
                    // legacy ordinary and feature-enable rows are replaced as before.
                    if (!row.request_id || retainedOwnedRequestIds.includes(row.request_id))
                        continue;
                    const result = supersede.run(row.request_id);
                    if (Number(result.changes ?? 0) > 0)
                        supersededRequestIds.push(row.request_id);
                }
            }
            this.writeRecord(db, input.record);
            return {
                status: 'created',
                supersededRequestIds,
                ...(retainedV2RequestIds.length > 0 ? { retainedV2RequestIds } : {}),
                ...(retainedOwnedRequestIds.length > 0 ? { retainedOwnedRequestIds } : {}),
            };
        }));
    }
    writeRecord(db, record) {
        const originChannelContext = record.originChannelContext
            ? parseQuestionnaireOriginChannelContext(JSON.stringify(record.originChannelContext))
            : undefined;
        db.prepare(`
        INSERT INTO questionnaire_requests (
          request_id, session_id, agent_name, msg_id, request_json, status,
          created_at, answered_at, reply_payload, injected_at, dismissed_at,
          origin_channel_context_json, response_mode
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(request_id) DO UPDATE SET
          -- response_mode is fixed at creation; a later upsert never changes it.
          response_mode = COALESCE(questionnaire_requests.response_mode, excluded.response_mode),
          session_id    = excluded.session_id,
          agent_name    = excluded.agent_name,
          msg_id        = excluded.msg_id,
          origin_channel_context_json = excluded.origin_channel_context_json,
          request_json  = excluded.request_json,
          status        = excluded.status,
          created_at    = excluded.created_at,
          answered_at   = excluded.answered_at,
          reply_payload = excluded.reply_payload,
          injected_at   = excluded.injected_at,
          dismissed_at  = excluded.dismissed_at
      `).run(record.requestId, record.sessionId, record.agentName ?? null, record.msgId ?? null, JSON.stringify(record.request), record.status, record.createdAt, record.answeredAt ?? null, record.replyPayload ? JSON.stringify(record.replyPayload) : null, record.injectedAt ?? null, record.dismissedAt ?? null, originChannelContext ? JSON.stringify(originChannelContext) : null, record.responseMode ?? null);
    }
    async replacePendingWhen(record, precondition) {
        return this.withDb((db) => runInImmediateTransaction(db, () => {
            if (!precondition())
                return { inserted: false, supersededRequestIds: [] };
            this.writeRecord(db, record);
            const rows = db
                .prepare(`
            SELECT request_id
            FROM questionnaire_requests
            WHERE session_id = ?
              AND status = 'pending'
              AND response_mode IS NULL
              AND request_id != ?
          `)
                .all(record.sessionId, record.requestId);
            db.prepare(`
          UPDATE questionnaire_requests
          SET status = 'superseded'
          WHERE session_id = ?
            AND status = 'pending'
            AND response_mode IS NULL
            AND request_id != ?
        `).run(record.sessionId, record.requestId);
            return {
                inserted: true,
                supersededRequestIds: rows.flatMap((row) => (row.request_id ? [row.request_id] : [])),
            };
        }));
    }
    async get(requestId) {
        return this.queries.get(requestId);
    }
    async delete(requestId) {
        return this.withDb((db) => {
            const result = db
                .prepare('DELETE FROM questionnaire_requests WHERE request_id = ?')
                .run(requestId);
            return Number(result.changes ?? 0) > 0;
        });
    }
    async getAll() {
        return this.queries.getAll();
    }
    async deleteBySession(sessionId) {
        return this.withDb((db) => {
            const result = db
                .prepare('DELETE FROM questionnaire_requests WHERE session_id = ?')
                .run(sessionId);
            return Number(result.changes ?? 0);
        });
    }
    async markAnswered(requestId, answeredAt, replyPayload) {
        if (!replyPayload) {
            return this.withDb((db) => {
                const result = db
                    .prepare(`
            UPDATE questionnaire_requests
            SET status = 'answered',
                answered_at = ?
            WHERE request_id = ?
          `)
                    .run(answeredAt, requestId);
                return Number(result.changes ?? 0) > 0;
            });
        }
        return this.settleReply(requestId, answeredAt, replyPayload, {
            requirePending: false,
        });
    }
    async settleReply(requestId, answeredAt, replyPayload, options) {
        return this.withDb((db) => {
            // Persist the reply payload in the same state transition. If the
            // process dies before synthetic message injection, startup recovery can
            // rebuild the exact `<questionnaire-response>` message from this row.
            const result = db
                .prepare(`
          UPDATE questionnaire_requests
          SET status = 'answered',
              answered_at = ?,
              reply_payload = ?
          WHERE request_id = ?
            ${options.requirePending ? "AND status = 'pending'" : ''}
        `)
                .run(answeredAt, JSON.stringify(replyPayload), requestId);
            return Number(result.changes ?? 0) > 0;
        });
    }
    async markAnsweredIfLatestPendingWhen(input, precondition) {
        return this.withDb((db) => runInImmediateTransaction(db, () => {
            if (!precondition())
                return false;
            const result = db
                .prepare(`
            UPDATE questionnaire_requests
            SET status = 'answered',
                answered_at = ?,
                reply_payload = COALESCE(?, reply_payload)
            WHERE request_id = ?
              AND session_id = ?
              AND status = 'pending'
              AND request_id = (
                SELECT latest.request_id
                FROM questionnaire_requests latest
                WHERE latest.session_id = ?
                  AND latest.status = 'pending'
                ORDER BY latest.created_at DESC, latest.rowid DESC
                LIMIT 1
              )
          `)
                .run(input.answeredAt, input.replyPayload ? JSON.stringify(input.replyPayload) : null, input.requestId, input.sessionId, input.sessionId);
            return Number(result.changes ?? 0) > 0;
        }));
    }
    async markInjected(requestId, injectedAt) {
        return this.withDb((db) => markQuestionnaireInjected(db, requestId, injectedAt, false));
    }
    async markInjectedOnce(requestId, injectedAt) {
        return this.withDb((db) => markQuestionnaireInjected(db, requestId, injectedAt, true));
    }
    async markDismissed(requestId, dismissedAt) {
        return this.withDb((db) => {
            const result = db
                .prepare(`
          UPDATE questionnaire_requests
          SET status = 'dismissed',
              dismissed_at = ?
          WHERE request_id = ?
            AND response_mode IS NULL
            AND (
              status = 'pending'
              OR (status = 'answered' AND injected_at IS NULL)
            )
        `)
                .run(dismissedAt, requestId);
            return Number(result.changes ?? 0) > 0;
        });
    }
    async expirePendingRequest(requestId, cutoff) {
        return this.withDb((db) => {
            const result = db
                .prepare(`
          UPDATE questionnaire_requests
          SET status = 'expired'
          WHERE request_id = ?
            AND status = 'pending'
            AND created_at < ?
        `)
                .run(requestId, cutoff);
            return Number(result.changes ?? 0) > 0;
        });
    }
    async markSuperseded(requestId) {
        return this.withDb((db) => {
            const result = db
                .prepare(`
          UPDATE questionnaire_requests
          SET status = 'superseded'
          WHERE request_id = ?
            AND response_mode IS NULL
            AND (
              status = 'pending'
              OR (status = 'answered' AND injected_at IS NULL)
            )
        `)
                .run(requestId);
            return Number(result.changes ?? 0) > 0;
        });
    }
    async supersedePendingBySession(sessionId, keepRequestId) {
        return this.withDb((db) => runInImmediateTransaction(db, () => {
            const rows = db
                .prepare(`
            SELECT request_id
            FROM questionnaire_requests
            WHERE session_id = ?
              AND status = 'pending'
              AND response_mode IS NULL
              AND request_id != ?
              AND response_mode IS NULL
          `)
                .all(sessionId, keepRequestId);
            if (rows.length === 0)
                return [];
            db.prepare(`
          UPDATE questionnaire_requests
          SET status = 'superseded'
          WHERE session_id = ?
            AND status = 'pending'
            AND response_mode IS NULL
            AND request_id != ?
            AND response_mode IS NULL
        `).run(sessionId, keepRequestId);
            return rows.flatMap((row) => (row.request_id ? [row.request_id] : []));
        }));
    }
    async expirePendingOlderThan(cutoff) {
        return this.withDb((db) => {
            const result = db
                .prepare(`
          UPDATE questionnaire_requests
          SET status = 'expired'
          WHERE status = 'pending'
            AND created_at < ?
            AND CASE
              WHEN json_valid(request_json)
                THEN COALESCE(json_extract(request_json, '$.purpose'), '') != 'goal'
              ELSE 1
            END
        `)
                .run(cutoff);
            return Number(result.changes ?? 0);
        });
    }
    async findAllPendingForRecovery() {
        return this.queries.findAllPendingForRecovery();
    }
    async findAnsweredPendingInject() {
        return this.queries.findAnsweredPendingInject();
    }
    async findOwnedActionsPendingCompletion() {
        return this.queries.findOwnedActionsPendingCompletion();
    }
    async findLatestPendingBySession(sessionId, createdAtCutoff = Number.MIN_SAFE_INTEGER, options = {}) {
        return this.queries.findLatestPendingBySession(sessionId, createdAtCutoff, options);
    }
    async findUnansweredV2BySession(sessionId, createdAtCutoff) {
        return this.queries.findUnansweredV2BySession(sessionId, createdAtCutoff);
    }
    async findLatestBySession(sessionId) {
        return this.queries.findLatestBySession(sessionId);
    }
    async findLatestPlanReviewBySession(sessionId, createdAtCutoff = Number.MIN_SAFE_INTEGER) {
        return this.queries.findLatestPlanReviewBySession(sessionId, createdAtCutoff);
    }
    async findUnresolvedForRewind(sessionId) {
        return this.withDb((db) => findUnresolvedQuestionnairesForRewind(db, sessionId));
    }
    async deleteUnresolvedForRewind(input) {
        if (input.requestIds.length === 0)
            return [];
        return this.withDb((db) => deleteUnresolvedQuestionnairesForRewind(db, input));
    }
    async hasUnresolvedBySession(sessionId) {
        return this.queries.hasUnresolvedBySession(sessionId);
    }
    withDb(fn) {
        return withLocalRuntimeDb(this.dataDir, fn);
    }
}
//# sourceMappingURL=sqlite-questionnaire-request-store.js.map