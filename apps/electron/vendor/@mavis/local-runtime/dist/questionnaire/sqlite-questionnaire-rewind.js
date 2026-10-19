import { runInImmediateTransaction } from '../persistence/db.js';
import { QUESTIONNAIRE_ROW_SELECT, toCompatibleQuestionnaireRequestRecord, } from './sqlite-row-codec.js';
const UNRESOLVED_PREDICATE = `
  status = 'pending'
  OR (status = 'answered' AND injected_at IS NULL)
`;
export function findUnresolvedQuestionnairesForRewind(db, sessionId) {
    const rows = db
        .prepare(`SELECT ${QUESTIONNAIRE_ROW_SELECT}
       FROM questionnaire_requests
       WHERE session_id = ? AND (${UNRESOLVED_PREDICATE})
       ORDER BY created_at ASC, request_id ASC`)
        .all(sessionId);
    return rows.map(toCompatibleQuestionnaireRequestRecord);
}
export function deleteUnresolvedQuestionnairesForRewind(db, input) {
    return runInImmediateTransaction(db, () => {
        const read = db.prepare(`SELECT ${QUESTIONNAIRE_ROW_SELECT}
       FROM questionnaire_requests
       WHERE request_id = ? AND session_id = ? AND (${UNRESOLVED_PREDICATE})`);
        const remove = db.prepare(`DELETE FROM questionnaire_requests
       WHERE request_id = ? AND session_id = ? AND (${UNRESOLVED_PREDICATE})`);
        return input.requestIds.flatMap((requestId) => {
            const row = read.get(requestId, input.sessionId);
            if (!row)
                return [];
            const deleted = remove.run(requestId, input.sessionId);
            return Number(deleted.changes ?? 0) > 0 ? [toCompatibleQuestionnaireRequestRecord(row)] : [];
        });
    });
}
//# sourceMappingURL=sqlite-questionnaire-rewind.js.map