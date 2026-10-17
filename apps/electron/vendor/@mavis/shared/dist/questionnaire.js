/**
 * V2 multi-step questionnaire schema.
 *
 * Shared between daemon (runtime normalize/validate/serialize) and UI
 * (composer rendering). The schema is intentionally forward-compatible with
 * a future `PendingDecision.kind = "questionnaire"` substrate — `schemaVersion`
 * is pinned to `2` so consumers can branch cleanly when V3 lands.
 *
 * Reference: docs/tasks/multi-step-ask-answer-implementation-plan.html
 * (decision: composer replacement; one question per step; required by default;
 * Others always present; image optional with safe URL schemes only).
 */
/** Shared expiry window for pending Questionnaire requests and Plan lifecycle fences. */
export const QUESTIONNAIRE_TTL_MS = 24 * 60 * 60 * 1000;
export function isOrdinaryQuestionnaireResponseOrigin(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    const origin = value;
    return (origin.kind === 'questionnaire-response' &&
        typeof origin.requestId === 'string' &&
        origin.requestId.length > 0 &&
        origin.mode === 'questionnaire' &&
        origin.purpose === 'ordinary' &&
        Object.keys(origin).length === 4);
}
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
/** The literal placeholder enforced for every step's Others input. */
export const ASK_OTHER_PLACEHOLDER = 'Others...';
/**
 * Tool name registered for the Mavis-owned `ask_user` flow. The daemon
 * marks this name as an interactive tool so the permission engine returns
 * `behavior: 'ask'`, which the legacy local-runtime plugin translates into a
 * `<questionnaire-ask>` XML instruction for the LLM to emit.
 */
export const ASK_USER_TOOL_NAME = 'ask_user';
//# sourceMappingURL=questionnaire.js.map