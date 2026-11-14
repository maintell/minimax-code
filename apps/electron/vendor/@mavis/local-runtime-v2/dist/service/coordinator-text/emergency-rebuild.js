/**
 * Reader: Bunny's main conversation model, in a segment an emergency rebuild opened.
 * Injected: when an emergency rebuild replaces a failing Turn's history: the incident notes of
 * the handoff header's 异常说明 section, the summary note of a safety-level header, and the
 * notes that stand in place of what the rebuild moved out of the foreground (tool results,
 * images and videos, over-long user messages). The parts of a previous header the rebuild reads
 * back (the carried summary and incident notes) are named here too.
 * Cache: written into the rebuilt history; the header and the notes open the new segment's
 * cached prefix.
 */
// The handoff header (turn-system/compaction/segment/emergency/handoff.ts, compose.ts).
/** Heading a carried summary in another format gets, whole. */
export const EMERGENCY_PREVIOUS_SUMMARY_HEADING = '上一段摘要';
/** The summary section of a safety-level header. */
export const EMERGENCY_SAFETY_SUMMARY_NOTE = '（这一段由安全档应急重建开启，没有带上一段的交接摘要；更早的事用 conversation_search 查找。）';
/** The line of a note that tells Bunny what to say to the user (spec 5.4). */
export const INCIDENT_TELL_USER_PREFIX = '- 对用户：';
/** What Bunny tells the user about the affected content it names, once, in one sentence like the example. */
function incidentTellUserOnce(subject, example) {
    return `${INCIDENT_TELL_USER_PREFIX}下一次对用户说话时，用一句话说明 ${subject} 没能直接用上、用户可以怎么做，像这样：“${example}”这两件事在同一句里说完，不另起一句解释是怎么处理的（例如读回了原件）；后来读回了原件也照样说这一句，说过一次就不再提。只说这些，对话里别的换成文字说明的内容不用提；也不要提重建、兜底、错误码这类内部原因。`;
}
/** The same request in a note carried into a later rebuild's header. */
export const INCIDENT_TOLD_USER_BEFORE = '- 对用户：这是之前一次的说明，之前已经告诉过用户就不再提；还没说过时，下一次对用户说话时用一句话说明上面哪条内容没能用上、用户可以怎么做。不要提重建、错误码这类内部原因。';
/** Each failure class as the note names it. */
const INCIDENT_CATEGORY_LABEL = {
    context_overflow: '超窗',
    request_too_large: '请求过大',
    image_limit: '图片数量超限',
    safety: '安全拒绝',
    bad_request: '其他 400',
    server_error: '服务端错误',
    incomplete_stream: '流不完整',
    empty_response: '报错形式的空回复',
    unknown: '未知错误',
    host_internal: '宿主内部失败',
    output_limit_exhausted: '输出上限重试用尽',
    history_corrupted: '历史文件损坏',
    builtin_config_corrupted: '内置配置损坏',
    optional_injection: '可选注入读不出',
};
const INCIDENT_LEVEL_LABEL = {
    standard: '标准',
    image: '图片',
    tight: '收紧',
    safety: '安全',
};
const INCIDENT_REPLACED_LABEL = {
    image: '图片',
    video: '视频',
    thinking: '思考内容',
    tool_result: '工具结果',
    user_message: '用户消息',
};
export function incidentNoteText(note) {
    const replaced = note.replaced.map(({ kind, count }) => `${INCIDENT_REPLACED_LABEL[kind] ?? kind} ${String(count)} 条`);
    return [
        `### ${note.time}（轮次 ${note.turnId}）`,
        `- 失败类别：${INCIDENT_CATEGORY_LABEL[note.category]}`,
        `- 错误码：${note.errorCode === undefined ? '无' : String(note.errorCode)}`,
        `- 原话摘录：${note.excerpt || '（无）'}`,
        ...(note.repair ? [incidentRepairLine(note.repair)] : []),
        `- 处理：应急重建，${INCIDENT_LEVEL_LABEL[note.level]}档；替换或剔除：${replaced.length > 0 ? replaced.join('、') : '无'}`,
        note.repair ? '- 这一轮重做了准备，接着进行。' : '- 这一轮已自动重试。',
        ...(note.affected ? incidentAffectedLines(note.affected, note.category) : []),
    ].join('\n');
}
/** How many records the repair cut or rolled back, and what it found again. */
function incidentRepairLine(repair) {
    const removed = String(repair.removedCount);
    const kept = String(repair.keptCount);
    const repaired = {
        prefix: `截掉坏记录起的 ${removed} 条记录，保留前 ${kept} 条`,
        snapshot: `能读的部分没有用户消息，回滚到第 ${String(repair.snapshotGeneration ?? '?')} 代快照（${kept} 条），原历史 ${removed} 条记录不再使用`,
        empty: `能读的部分没有用户消息，也没有快照，从空历史开始，原历史 ${removed} 条记录不再使用`,
    }[repair.kind];
    const recalled = repair.recalledCount > 0
        ? `；从对话记录找回 ${String(repair.recalledCount)} 条还没回复的用户消息`
        : '';
    return `- 历史修复：${repaired}${recalled}。`;
}
/** How the soft line shortened a message's own words (emergency/fit.ts). */
const INCIDENT_SHORTENED = {
    preview: '原话太长，只留了开头和结尾',
    file: '原话太长，存进了文件',
};
function incidentAffectedLines(affected, category) {
    const named = affected.named.map((item) => {
        const names = item.media ? `（${item.names.length > 0 ? item.names.join('、') : '附件'}）` : '';
        const how = item.shortened
            ? `${item.media ? '，' : ' '}${INCIDENT_SHORTENED[item.shortened]}`
            : '';
        return `消息 ${item.messageId}${names}${how}`;
    });
    const items = affected.unlisted === 0
        ? named
        : [
            ...named,
            `${named.length > 0 ? '另有' : '共'} ${String(affected.unlisted)} 条消息没有逐条列出，对话里它们的占位写明了消息 ID 与文件名`,
        ];
    return [
        `- 受影响的用户内容：${items.join('；')}${affected.media ? '，其中的图片和视频换成了文字说明' : ''}。`,
        incidentTellUserOnce(tellSubject(affected), tellExample(affected, category)),
    ];
}
/** Items the tell-once line names one by one; with more it points at the list. */
const TELL_NAMED_MAX = 3;
/** What the tell-once line names: the files, else the messages, as the affected line lists them. */
function tellSubject(affected) {
    if (affected.unlisted > 0 || affected.named.length > TELL_NAMED_MAX)
        return '上面列出的这些内容';
    const named = affected.named.map((item) => item.media && item.names.length > 0 ? item.names.join('、') : `消息 ${item.messageId}`);
    return named.join('、');
}
/** The sentence the tell-once line offers: what the user sees named, and one thing to do about it. */
function tellExample(affected, category) {
    if (!affected.media) {
        const one = affected.named.length + affected.unlisted === 1;
        return `你刚才${one ? '那条' : '那几条'}消息太长，没能完整用上，下次可以分几次发。`;
    }
    const listed = affected.unlisted === 0 && affected.named.length <= TELL_NAMED_MAX;
    const files = listed ? affected.named.flatMap((item) => (item.media ? item.names : [])) : [];
    const what = files.length > 0 ? files.join('、') : '你发的这几个附件';
    const action = category === 'bad_request' ? '换个格式再发' : '少放几张或分开发';
    return `${what} 这次没能直接用上，下次可以${action}。`;
}
const MOVED_MEDIA_LABEL = { image: '图片', video: '视频' };
/** A saved file, with the line-cut copy when a line of it is too long for the read tool. */
export function movedFilePath(path, readablePath) {
    return readablePath ? `${path}（单行过长时读按行切开的副本 ${readablePath}）` : path;
}
/** A tool result moved into a file whole. */
export function movedToolResultText(toolName, toolCallId, path) {
    return `工具结果已移出上下文（${toolName}，调用 ${toolCallId}）：全文存为文件 ${path}，需要时读取。`;
}
/** A tool result's image or video moved into a file, in its place. */
export function movedToolMediaPlaceholder(type, path) {
    return `[工具结果里的${MOVED_MEDIA_LABEL[type]}已移出上下文，存为文件 ${path}，需要时读取。]`;
}
/** The line naming the file a tool result's image or video went into. */
export function savedToolMediaLine(type, path) {
    return `结果里的${MOVED_MEDIA_LABEL[type]}存为文件 ${path}。`;
}
/** A user's image or video replaced by its description; without an asset, its message. */
export function mediaPlaceholderText(type, messageId, asset) {
    const label = MOVED_MEDIA_LABEL[type];
    if (!asset)
        return `[${label}已换成文字说明：消息 ${messageId} 的一个附件，原件用 conversation_read 按消息 ID 读取。]`;
    const description = asset.description ?? '没有存过描述';
    return `[${label}已换成文字说明：资产 ID ${asset.assetId}，文件名 ${asset.name}，描述：${description}。原件按资产 ID 读取。]`;
}
/** A placeholder's rough length: what a replaced image or video weighs in the retention shares. */
export const MEDIA_PLACEHOLDER_WEIGHT = '[图片已换成文字说明：资产 ID，文件名，描述。原件按资产 ID 读取。]';
/** An over-long user message as its head and tail; `path` when the whole of it went into a file. */
export function userMessagePreviewText(input) {
    const { messageId, assets } = input;
    return [
        `用户消息过长，这里只保留开头和结尾（消息 ID：${messageId}）。`,
        input.body,
        `完整原文用 conversation_read 按消息 ID ${messageId} 读取。`,
        ...(input.path === undefined ? [] : [`全文另存为文件 ${input.path}，需要时读取。`]),
        ...(assets.length > 0
            ? [`附件：${assets.map((asset) => `${asset.name}（资产 ID ${asset.assetId}）`).join('、')}`]
            : []),
    ].join('\n');
}
/** An over-long tool result as its head and tail, the whole of it in a file. */
export function toolResultPreviewText(input) {
    return [
        `工具结果过长，这里只保留开头和结尾（${input.toolName}，调用 ${input.toolCallId}）。`,
        input.body,
        `全文存为文件 ${input.path}，需要时读取。`,
        ...input.mediaLines,
    ].join('\n');
}
//# sourceMappingURL=emergency-rebuild.js.map