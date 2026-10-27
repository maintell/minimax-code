import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';
import { redactMemorySecrets } from '../secret-redactor.js';
import { estimateCaptureTokens } from '../contracts/token-estimate.js';
/** 在裁剪前判定资格，同时投影脱敏正文，供扫描与直接抽取共用。 */
export function prepareCaptureHistory(source) {
    if (!validIdentityVector(source))
        return { status: 'invalid' };
    const state = {
        events: [],
        pendingUser: false,
        completeTurn: false,
        effectiveTokens: 0,
    };
    for (const [index, eventId] of source.identityVector.entries()) {
        if (!advanceCaptureHistory(state, eventId, source.messages[index]))
            return { status: 'invalid' };
    }
    return state.completeTurn && state.effectiveTokens >= 100
        ? { status: 'found', events: state.events }
        : { status: 'ineligible' };
}
function validIdentityVector(source) {
    return (source.messages.length === source.identityVector.length &&
        new Set(source.identityVector).size === source.identityVector.length &&
        source.identityVector.every((id) => typeof id === 'string' && id.trim().length > 0 && !id.includes('\0')));
}
function advanceCaptureHistory(state, eventId, message) {
    if (!isRecord(message))
        return true;
    if (message.role === 'user')
        return advanceUserInput(state, eventId, message);
    if (!state.pendingUser)
        return true;
    const event = mapMessage(eventId, state.events.length, message);
    if (!event)
        return true;
    if (!validUtf8(event.content))
        return false;
    if (event.role === 'assistant') {
        state.completeTurn ||= event.content.trim().length > 0;
        state.pendingUser = false;
        state.effectiveTokens += countBodyTokens(event.content);
    }
    if (event.content.length > 0)
        state.events.push(event);
    return true;
}
function advanceUserInput(state, eventId, message) {
    const text = genuineUserText(message);
    if (text === undefined)
        return false;
    if (!text.trim()) {
        // 后台结果通知可在问答中途到达；独立定时请求不继承未完成的用户问题。
        if (isCronInput(stripGeneratedBlocks(visibleText(message.content))))
            state.pendingUser = false;
        return true;
    }
    const event = makeEvent({
        eventId,
        sequence: state.events.length,
        role: 'user',
        kind: 'text',
        content: text,
    });
    if (!validUtf8(event.content))
        return false;
    state.pendingUser = true;
    state.effectiveTokens += countBodyTokens(event.content);
    state.events.push(event);
    return true;
}
function mapMessage(eventId, sequence, value) {
    if (!isRecord(value) || typeof value.role !== 'string')
        return undefined;
    switch (value.role) {
        case 'assistant':
            if (value.stopReason !== 'stop')
                return undefined;
            return makeEvent({
                eventId,
                sequence,
                role: 'assistant',
                kind: 'text',
                content: value.content,
            });
        case 'tool':
        case 'toolResult':
        case 'tool-result': {
            const event = makeEvent({
                eventId,
                sequence,
                role: 'tool',
                kind: 'tool-result',
                content: value.content,
            });
            return { ...event, content: trimToolResult(event.content) };
        }
        default:
            return undefined;
    }
}
function makeEvent(input) {
    const text = visibleText(input.content);
    // 换行统一为 LF 后再脱敏,保证相同输入产生相同字节(§2.4)。
    return {
        eventId: input.eventId,
        sequence: input.sequence,
        role: input.role,
        kind: input.kind,
        content: redactMemorySecrets(text.replace(/\r\n?/gu, '\n')).content,
    };
}
/**
 * 工具输出很少值得记，却最占抽取预算：只保留开头与结尾（错误常在末尾），
 * 让同样的预算容纳更多轮用户与助手正文。截断在脱敏之后，不会切开密钥替换标记。
 */
const TOOL_RESULT_HEAD_CHARS = 1200;
const TOOL_RESULT_TAIL_CHARS = 400;
function trimToolResult(content) {
    if (content.length <= TOOL_RESULT_HEAD_CHARS + TOOL_RESULT_TAIL_CHARS)
        return content;
    const head = content.slice(0, codePointBoundary(content, TOOL_RESULT_HEAD_CHARS));
    const tail = content.slice(codePointBoundary(content, content.length - TOOL_RESULT_TAIL_CHARS));
    const omitted = content.length - head.length - tail.length;
    return `${head}\n…[工具输出已截断，省略 ${omitted} 个字符]…\n${tail}`;
}
/** 截断点落在代理对中间时后移一位，保证结果仍是合法 UTF-16。 */
function codePointBoundary(text, index) {
    const code = text.charCodeAt(index);
    return code >= 0xdc00 && code <= 0xdfff ? index + 1 : index;
}
/** 用户消息开启一个 Turn group；裁剪保留完整问题、回答与工具结果。 */
export function truncateToTokenBudget(events, maxInputTokens) {
    const groups = [];
    for (const event of events) {
        if (event.role === 'user' || groups.length === 0)
            groups.push([]);
        groups[groups.length - 1]?.push(event);
    }
    const kept = [];
    let used = 0;
    for (const group of groups.reverse()) {
        const cost = group.reduce((total, event) => total + estimateCaptureTokens(event.content), 0);
        if (used + cost > Math.max(0, maxInputTokens))
            break;
        kept.push(group);
        used += cost;
    }
    return kept.reverse().flat();
}
function visibleText(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    return content
        .flatMap((part) => isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : [])
        .join('\n');
}
/** 新格式明确标注用户正文；旧格式仅剥离已知系统注入协议。 */
function genuineUserText(message) {
    if (message.archonCompaction)
        return '';
    if (Object.hasOwn(message, 'genuineUserQueryText')) {
        return typeof message.genuineUserQueryText === 'string'
            ? message.genuineUserQueryText
            : undefined;
    }
    const content = visibleText(message.content);
    if (Object.hasOwn(message, 'canonicalTextRange')) {
        return canonicalRangeText(content, message.canonicalTextRange);
    }
    const text = stripGeneratedBlocks(content);
    return isCronInput(text) ? '' : text;
}
function stripGeneratedBlocks(content) {
    return content
        .replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/giu, '')
        .replace(/<background-task-finished\b[^>]*>[\s\S]*?<\/background-task-finished>/giu, '')
        .replace(/<(?:system-reminder|background-task-finished)\b[^>]*\/>/giu, '')
        .trim();
}
function isCronInput(text) {
    return /^\[(?:System CronTask|Cron Report\b)[^\]]*\]/iu.test(text);
}
function canonicalRangeText(content, range) {
    if (!isRecord(range))
        return undefined;
    const { startOffset, endOffset } = range;
    if (typeof startOffset !== 'number' ||
        typeof endOffset !== 'number' ||
        !Number.isSafeInteger(startOffset) ||
        !Number.isSafeInteger(endOffset) ||
        startOffset < 0 ||
        endOffset < startOffset ||
        endOffset > content.length)
        return undefined;
    return content.slice(startOffset, endOffset);
}
function countBodyTokens(text) {
    return countTokens(text.trim(), { disallowedSpecial: new Set() });
}
function validUtf8(text) {
    return Buffer.from(text, 'utf8').toString('utf8') === text;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=capture-history.js.map