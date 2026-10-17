import { SessionHandoffError } from '../errors.js';
const CLOUD_HANDOFF_TAG = /<\/?cloud-session-handoff\b[^>]*>/giu;
const SUMMARY_MESSAGE_LIMIT = 12;
const SUMMARY_LINE_MAX_LENGTH = 400;
/**
 * 云端会话里最终只有两条消息:第一条是这里合成的本地历史摘要,第二条是服务端
 * provisioning 用 `handoff.objective` 生成的 query(既是用户看到的内容,也是 agent
 * 的续跑输入)。所以上传的历史**只带摘要这一条** —— 再传一份 query 只会重复。
 *
 * 之所以不逐字上传:桌面端历史里有大量云端不认识的东西 —— 工具调用、附件、
 * `<cloud-session-handoff>` 这类只有端上能渲染的标记(它的卡片要去查本地 dispatch
 * 状态,在云端会话里必然是坏的)。
 */
export function buildHandoffHistoryDigest(input) {
    const marker = assertCanonicalMarker(input.messages, input.dispatchId);
    const summary = input.summary.trim();
    return [
        {
            msg_id: `${input.dispatchId}-summary`,
            role: 'assistant',
            // marker 跟着摘要走:它必须落在最后一条 assistant 消息的尾部,而摘要就是唯一
            // 一条。服务端按 operation 校验它,校验通过后在落库前剥离,因此云端持久化与
            // 渲染的是干净的摘要正文。
            msg_content: summary ? `${summary}\n\n${marker}` : marker,
            kind: 'handoff_summary',
        },
    ];
}
/**
 * 摘要器的输入:去掉这次要派发的 query(它会由 provisioning 单独成一条,重复总结没
 * 意义),并抹掉只有端上认识的 handoff 标记,免得摘要里出现一张云端打不开的卡片。
 * 入参必须是**已脱敏**的消息。
 */
export function summaryInputMessages(redactedMessages, query) {
    const trimmedQuery = query.trim();
    const result = [];
    let droppedQuery = false;
    for (let index = redactedMessages.length - 1; index >= 0; index -= 1) {
        const message = redactedMessages[index];
        if (!message)
            continue;
        const content = typeof message.msg_content === 'string' ? message.msg_content : '';
        if (!droppedQuery && message.role === 'user' && content.trim() === trimmedQuery) {
            droppedQuery = true;
            continue;
        }
        const stripped = content.replaceAll(CLOUD_HANDOFF_TAG, '').trimEnd();
        result.push(stripped === content ? message : { ...message, msg_content: stripped });
    }
    return result.reverse();
}
/**
 * 摘要替代逐字文稿之后,marker 的"唯一且在尾部"这条不变式没人守了 —— 上传的两条
 * 消息是合成的。所以在这里对**原始**历史再校验一次:marker 由本地 turn hook 在派发
 * 那一轮写入,它证明这次派发确实经过了本地会话,而不是只凭客户端自报的元数据。
 * 不成立就地失败,不必跑完整个上传再被服务端拒。
 */
function assertCanonicalMarker(messages, dispatchId) {
    const marker = `<cloud-session-handoff dispatch-id="${dispatchId}" />`;
    let count = 0;
    for (const message of messages) {
        const content = typeof message.msg_content === 'string' ? message.msg_content : '';
        count += content.split(marker).length - 1;
    }
    const last = messages.at(-1);
    const lastContent = typeof last?.msg_content === 'string' ? last.msg_content : '';
    if (count !== 1 || last?.role !== 'assistant' || !lastContent.trimEnd().endsWith(marker)) {
        throw new SessionHandoffError('HANDOFF_ARTIFACT_INVALID', 'Local Session history is missing the canonical Cloud handoff marker');
    }
    return marker;
}
/**
 * 模型不可用、超时或返回空时的兜底摘要。派发不能因为摘要生成失败就卡住,所以这里
 * 只做确定性的裁剪:入参必须是**已脱敏**的消息,否则会把用户没批准的敏感内容带上云端。
 */
export function fallbackHandoffSummary(redactedMessages) {
    const lines = [];
    for (const message of redactedMessages.slice(-SUMMARY_MESSAGE_LIMIT)) {
        const role = typeof message.role === 'string' ? message.role : 'message';
        const content = typeof message.msg_content === 'string' ? message.msg_content : '';
        const text = content.replaceAll(/\s+/gu, ' ').trim();
        if (!text)
            continue;
        lines.push(`- ${role}: ${truncate(text, SUMMARY_LINE_MAX_LENGTH)}`);
    }
    if (lines.length === 0)
        return '(本地会话没有可摘要的对话内容。)';
    return ['本地会话最近的对话记录:', ...lines].join('\n');
}
function truncate(value, limit) {
    return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}
//# sourceMappingURL=history-digest.js.map