const INTERNAL_USER_SOURCES = new Set(['system', 'communication', 'team-engine']);
const SYNTHETIC_RESPONSE_RE = /<(questionnaire|permission)-response\b/u;
const NAVIGATION_BLOCK_RE = /<(agent-message|agent-context|system-reminder|peer-memory-path|engine-message|inbound-context|html-selection-context|archon_internal_context|locale-context|runtime-data-context|permission-ask|permission-response|questionnaire-ask|questionnaire-response|deliver-assets|deliver_assets|mavis-thinking)\b[^>]*>[\s\S]*?<\/\1\s*>/giu;
const MEDIA_TAG_RE = /<media\b[^>]*\/?\s*>/giu;
const UNICODE_WHITESPACE_RE = /\s+/gu;
// Shared display rows can carry v2 kinds beyond the legacy AgentMessage protocol.
export function isNavigableUserInput(message) {
    if (message.role !== 'user')
        return false;
    if (message.kind != null && message.kind !== 'steered_user')
        return false;
    if (message.source && INTERNAL_USER_SOURCES.has(message.source))
        return false;
    return !SYNTHETIC_RESPONSE_RE.test(message.msg_content ?? '');
}
export function projectNavigationText(content) {
    if (!content)
        return '';
    return content
        .replace(NAVIGATION_BLOCK_RE, '')
        .replace(MEDIA_TAG_RE, '')
        .trim()
        .replace(UNICODE_WHITESPACE_RE, ' ');
}
export function takeUnicodeCodePoints(content, limit) {
    if (limit <= 0 || !content)
        return '';
    return [...content].slice(0, limit).join('');
}
//# sourceMappingURL=text.js.map