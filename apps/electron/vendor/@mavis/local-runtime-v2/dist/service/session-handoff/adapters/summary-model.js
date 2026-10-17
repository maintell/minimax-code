import { runHandoffModelTurn, } from './recommendation-model.js';
const SUMMARY_TURN_ID = 'session-handoff-history-summary';
const MAX_OUTPUT_TOKENS = 1_024;
const MAX_PROMPT_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 2_000;
const SYSTEM_PROMPT = [
    'You summarize a Desktop coding Session whose work is moving to Cloud.',
    'The summary becomes the first message the Cloud Session sees, so it is the only context the',
    'Cloud agent has about what already happened locally.',
    '',
    'Cover what the user asked for, what was already done, decisions and constraints that still',
    'apply, and anything left unfinished. Name the files that matter. Keep it factual: never invent',
    'work that is not in the transcript.',
    '',
    'Do not repeat the request that is being handed off — it arrives separately as the next message.',
    'Answer with plain prose or short bullets, no code fences and no preamble.',
    'Write in the language the Session itself uses.',
].join('\n');
/**
 * 用本地会话自己的模型把历史压成一段摘要。
 *
 * 抛错就是这个端口表达「不可用」的方式:派发服务会退回确定性的兜底摘要,不让摘要
 * 生成失败阻断整条派发。
 */
export function createHandoffSummaryModelPort(options) {
    return {
        async summarize(request) {
            const final = await runHandoffModelTurn(options, {
                session: request.session,
                turnId: SUMMARY_TURN_ID,
                systemPrompt: SYSTEM_PROMPT,
                userPrompt: buildSummaryPrompt(request.redactedMessages),
                maxTokens: MAX_OUTPUT_TOKENS,
                signal: request.signal,
            });
            const text = readAssistantText(final).trim();
            // 空答复不是"没什么可总结的",是这次调用没拿到可用结果 —— 交给兜底。
            if (!text)
                throw new Error('Handoff summary model returned no text');
            return text;
        },
    };
}
/**
 * 入参已经是脱敏后的消息:未获批准的敏感路径在上游被抹掉了。这里只做长度裁剪,
 * 不再触碰内容。
 */
function buildSummaryPrompt(messages) {
    const lines = [];
    for (const message of messages.slice(-MAX_PROMPT_MESSAGES)) {
        const role = typeof message.role === 'string' ? message.role : 'message';
        const content = typeof message.msg_content === 'string' ? message.msg_content : '';
        const text = content.trim();
        if (!text)
            continue;
        lines.push(`${role}: ${truncate(text, MAX_MESSAGE_CHARS)}`);
    }
    if (lines.length === 0)
        return 'The Local Session has no summarizable conversation.';
    return `Local Session transcript:\n\n${lines.join('\n\n')}`;
}
function readAssistantText(final) {
    if (typeof final.content === 'string')
        return final.content;
    if (!Array.isArray(final.content))
        return '';
    return final.content
        .flatMap((block) => block && typeof block === 'object' && block.type === 'text'
        ? [String(block.text ?? '')]
        : [])
        .join('');
}
function truncate(value, limit) {
    return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}
//# sourceMappingURL=summary-model.js.map