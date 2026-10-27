/** Shared expiry window for pending Questionnaire requests and Plan lifecycle fences. */
export const QUESTIONNAIRE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Steering producer id for an AskUser v2 answer steered into a running Turn.
 * It is machine delivery (never counts as new user input), but the answer is
 * an already-persisted user decision, so Turn teardown must keep it instead of
 * dropping it like other machine steering.
 */
export const QUESTIONNAIRE_ANSWER_STEERING_PRODUCER = 'questionnaire-reply';
/** 任何问卷回答的 origin，不管问卷是做什么用的。 */
export function isQuestionnaireResponseOrigin(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    return value.kind === 'questionnaire-response';
}
/** 消息正文是问卷回答，而不是用户打的字。 */
export function isQuestionnaireResponseText(content) {
    return /<questionnaire-response\b/u.test(content);
}
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
/** Match the chat attachment budget; bound decoded pixels before image preprocessing. */
export const QUESTIONNAIRE_CONTEXT_IMAGE_LIMITS = {
    count: 10,
    bytes: 100 * 1024 * 1024,
    pixels: 40_000_000,
};
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