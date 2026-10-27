/** Delivery acknowledgements optionally use CAS to publish a single transition. */
export function markQuestionnaireInjected(db, requestId, injectedAt, once) {
    const statement = once
        ? 'UPDATE questionnaire_requests SET injected_at = ? WHERE request_id = ? AND injected_at IS NULL'
        : 'UPDATE questionnaire_requests SET injected_at = ? WHERE request_id = ?';
    const result = db.prepare(statement).run(injectedAt, requestId);
    return Number(result.changes ?? 0) > 0;
}
//# sourceMappingURL=sqlite-questionnaire-delivery.js.map