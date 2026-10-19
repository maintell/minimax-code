/**
 * Suffix appended to a step id to name its free-text ("Others...") input.
 *
 * Declared here (not in `feishu-card.ts`) because both the card encoder and
 * this decoder need it; hosting it in the encoder while the encoder re-exports
 * this file's decode helpers formed a module cycle. `feishu-card.ts`
 * re-exports it so external callers keep importing from the encoder.
 */
export const QUESTIONNAIRE_OTHER_SUFFIX = '__other';
/**
 * Card 2.0 form-submit decoder helpers. Split out of `feishu-card.ts` so the
 * card-encoder file stays under the default 500-line budget. The wire-shape
 * mirrors `feat/im-genui-full-mr` (`im-slice-all`) — Feishu posts
 * `action.value` (submit-button payload) and `action.form_value` (the form
 * state, keyed by per-step name) — both of which we re-shape into a canonical
 * {@link AskQuestionnaireReplyPayload}.
 */
function toObject(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return null;
    return value;
}
/**
 * Extract the questionnaire-submit button value from a Feishu card-action
 * event. Searches the same candidate locations across v1/v2 card layouts; each
 * candidate may be an object OR a JSON string. Returns the value only when
 * `kind === 'questionnaire_submit'` and `requestId` is a non-empty string.
 */
export function extractQuestionnaireSubmitValue(rawEvent) {
    const event = toObject(rawEvent);
    if (!event)
        return null;
    const eventBody = toObject(event.event);
    const actionObj = toObject(event.action) ?? toObject(eventBody?.action);
    const candidates = [
        actionObj?.value,
        event.action_value,
        event.value,
        eventBody?.action_value,
        eventBody?.value,
    ];
    for (const candidate of candidates) {
        const valueObj = decodeActionValueCandidate(candidate);
        if (!valueObj)
            continue;
        if (valueObj.kind === 'questionnaire_submit' &&
            typeof valueObj.requestId === 'string' &&
            valueObj.requestId.length > 0) {
            return {
                kind: 'questionnaire_submit',
                requestId: valueObj.requestId,
                sessionId: typeof valueObj.sessionId === 'string' ? valueObj.sessionId : '',
            };
        }
    }
    return null;
}
/**
 * Extract the form_value map (name → submitted value) from a Feishu form
 * submit card-action event. Feishu places it on `action.form_value` (v2) and
 * some SDK shapes flatten it to `form_value` at top level (or under `event`).
 */
export function extractFormValue(rawEvent) {
    const event = toObject(rawEvent);
    if (!event)
        return {};
    const eventBody = toObject(event.event);
    const actionObj = toObject(event.action) ?? toObject(eventBody?.action);
    const candidates = [actionObj?.form_value, event.form_value, eventBody?.form_value];
    for (const candidate of candidates) {
        const obj = toObject(candidate);
        if (obj)
            return obj;
    }
    return {};
}
/** Coerce a select/multi_select form_value field into a string[] of option ids. */
function normalizeSelected(value) {
    if (typeof value === 'string')
        return value ? [value] : [];
    if (Array.isArray(value)) {
        return value.filter((v) => typeof v === 'string' && v.length > 0);
    }
    return [];
}
/**
 * Map a Feishu form_value object to questionnaire reply answers. One answer
 * per step; an empty step (no selection, no free text) is marked `skipped`
 * so a required step left blank does not fail validation.
 */
export function mapFormValueToAnswers(request, formValue) {
    const answers = [];
    for (const step of request.steps) {
        const selectedOptionIds = normalizeSelected(formValue[step.id]);
        const otherRaw = formValue[`${step.id}${QUESTIONNAIRE_OTHER_SUFFIX}`];
        const otherText = typeof otherRaw === 'string' ? otherRaw.trim() : '';
        const answer = {
            stepId: step.id,
            selectedOptionIds,
            selectedOther: otherText.length > 0,
        };
        if (otherText.length > 0)
            answer.otherText = otherText;
        if (selectedOptionIds.length === 0 && otherText.length === 0) {
            answer.skipped = true;
        }
        answers.push(answer);
    }
    return answers;
}
/** Card action values arrive either as objects or JSON strings; decode both. */
function decodeActionValueCandidate(candidate) {
    if (typeof candidate === 'string') {
        try {
            return toObject(JSON.parse(candidate));
        }
        catch {
            return null;
        }
    }
    return toObject(candidate);
}
//# sourceMappingURL=feishu-card-form.js.map