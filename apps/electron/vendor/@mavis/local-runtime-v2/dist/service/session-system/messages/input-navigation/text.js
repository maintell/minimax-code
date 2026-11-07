import { toNavigationPlainText } from '@mavis/shared/navigation-text';
import { isOrdinaryQuestionnaireResponseOrigin } from '@mavis/shared/questionnaire';
/** 来自这些来源的 user 行不是用户本人输入的。 */
export const INTERNAL_USER_SOURCES = ['system', 'communication', 'team-engine'];
/** 替用户发出的问卷回复和权限回复的开头标签。 */
export const SYNTHETIC_RESPONSE_MARKERS = [
    '<questionnaire-response',
    '<permission-response',
];
const SYNTHETIC_RESPONSE_RE = new RegExp(`(?:${SYNTHETIC_RESPONSE_MARKERS.join('|')})\\b`, 'u');
const QUESTIONNAIRE_RESPONSE_RE = /<questionnaire-response\b/u;
export function isNavigableUserInput(message) {
    if (message.role !== 'user')
        return false;
    if (message.kind != null && message.kind !== 'steered_user')
        return false;
    if (message.source && INTERNAL_USER_SOURCES.includes(message.source))
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