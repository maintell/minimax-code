import { CONTEXT_USAGE_PROMPT_KINDS } from '../preparation/contracts.js';
export function renderAgentRuntimeReminders(reminders) {
    return reminders
        .map(({ providerName, reminder }) => {
        const content = reminder.content.trim();
        if (!isCompleteSystemReminderBlock(content)) {
            throw new Error(`AgentRuntime reminder provider '${providerName}' must emit one non-empty complete <system-reminder> block.`);
        }
        return content;
    })
        .join('\n\n');
}
export function readPreparedSystemPrompt(agentConfig) {
    const value = agentConfig.system_prompt;
    if (typeof value !== 'string') {
        throw new TypeError('Prepared AgentConfig.system_prompt must be a string.');
    }
    return value;
}
export function readPreparedContextUsagePromptRanges(agentConfig, systemPromptPrefix, baseSystemPrompt) {
    const value = agentConfig.contextUsagePromptRanges;
    if (!Array.isArray(value) || baseSystemPrompt !== baseSystemPrompt.trim())
        return undefined;
    const ranges = value.map((candidate) => readContextUsagePromptRange(candidate, baseSystemPrompt));
    if (!ranges.every((range) => range !== undefined)) {
        return undefined;
    }
    const prefix = systemPromptPrefix.trim();
    const offset = prefix ? prefix.length + 2 : 0;
    return ranges.map((range) => ({
        ...range,
        startOffset: range.startOffset + offset,
        endOffset: range.endOffset + offset,
    }));
}
export function joinPrompt(...contributions) {
    return contributions
        .map((value) => value.trim())
        .filter(Boolean)
        .join('\n\n');
}
export function joinUserPrompt(prefix, runtimeReminders, hostReminders, canonicalUserText) {
    const leading = joinPrompt(prefix, runtimeReminders, hostReminders);
    if (!leading)
        return canonicalUserText;
    return canonicalUserText ? `${leading}\n\n${canonicalUserText}` : leading;
}
function isCompleteSystemReminderBlock(content) {
    const opening = '<system-reminder>';
    const closing = '</system-reminder>';
    if (!content.startsWith(opening) || !content.endsWith(closing))
        return false;
    const body = content.slice(opening.length, -closing.length);
    return Boolean(body.trim()) && !/<\s*\/?\s*system-reminder(?=[\s/>])/iu.test(body);
}
function readContextUsagePromptRange(value, systemPrompt) {
    if (!value || typeof value !== 'object')
        return undefined;
    const kind = Reflect.get(value, 'kind');
    const startOffset = Reflect.get(value, 'startOffset');
    const endOffset = Reflect.get(value, 'endOffset');
    if (!isContextUsagePromptKind(kind))
        return undefined;
    if (!isValidPromptRange(startOffset, endOffset, systemPrompt.length))
        return undefined;
    return { kind, startOffset, endOffset };
}
function isContextUsagePromptKind(value) {
    return CONTEXT_USAGE_PROMPT_KINDS.some((kind) => kind === value);
}
function isValidPromptRange(startOffset, endOffset, promptLength) {
    if (typeof startOffset !== 'number' || typeof endOffset !== 'number')
        return false;
    return (Number.isInteger(startOffset) &&
        Number.isInteger(endOffset) &&
        startOffset >= 0 &&
        endOffset > startOffset &&
        endOffset <= promptLength);
}
//# sourceMappingURL=prompt.js.map