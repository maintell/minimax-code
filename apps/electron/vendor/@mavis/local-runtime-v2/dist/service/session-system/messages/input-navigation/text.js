import { toNavigationPlainText } from '@mavis/shared/navigation-text';
import { isOrdinaryQuestionnaireResponseOrigin } from '@mavis/shared/questionnaire';
const INTERNAL_USER_SOURCES = new Set(['system', 'communication', 'team-engine']);
const SYNTHETIC_RESPONSE_RE = /<(questionnaire|permission)-response\b/u;
const QUESTIONNAIRE_RESPONSE_RE = /<questionnaire-response\b/u;
export function isNavigableUserInput(message) {
    if (message.role !== 'user' || message.kind != null)
        return false;
    if (message.source && INTERNAL_USER_SOURCES.has(message.source))
        return false;
    return !SYNTHETIC_RESPONSE_RE.test(messageContent(message));
}
export function projectNavigationText(message) {
    return toNavigationPlainText(messageContent(message));
}
export function isQuestionnaireResponseInput(message) {
    return (message.role === 'user' &&
        (message.source === 'questionnaire' ||
            QUESTIONNAIRE_RESPONSE_RE.test(messageContent(message)) ||
            questionnaireResponseOrigin(message)?.kind === 'questionnaire-response'));
}
export function isRewindableQuestionnaireResponseInput(message) {
    return (message.role === 'user' && isOrdinaryQuestionnaireResponseOrigin(message.sourceContext?.origin));
}
export function takeUnicodeCodePoints(content, limit) {
    if (limit <= 0 || !content)
        return '';
    return [...content].slice(0, limit).join('');
}
function messageContent(message) {
    const value = message.msg_content ?? message.msgContent;
    return typeof value === 'string' ? value : '';
}
function questionnaireResponseOrigin(message) {
    const origin = message.sourceContext?.origin;
    return typeof origin === 'object' && origin !== null && !Array.isArray(origin)
        ? origin
        : undefined;
}
//# sourceMappingURL=text.js.map