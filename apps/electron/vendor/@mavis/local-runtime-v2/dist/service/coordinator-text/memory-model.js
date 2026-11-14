/**
 * Reader: Bunny's memory model, the recorder and the consolidator that edit the memory files in
 * a work directory; the format errors also come back to Bunny's main conversation from the
 * remember tool, and to the user from memory settings.
 * Injected: the briefing is the memory model's first user message and the conversation input is
 * a file it reads, both when a capture or consolidation run starts; a format error is the result
 * of the tool call or settings save that wrote the bad file.
 * Cache: each run is a fresh request with no shared prefix; a format error in the main
 * conversation is written into its history after the call.
 */
// A memory run's input (bunny/memory/memory.service.ts, session-source.ts).
export function memoryBriefing(input) {
    return `今天 ${input.today}。新增主条目 ID 从 m-${String(input.nextEntryNumber).padStart(2, '0')} 开始，不得复用旧 ID。先完整读取所有输入，按提示词编辑文件。可写文件：${input.writable.join('、')}。主 memory 最多 ${input.maxMemoryTokens} token。完成后停止调用工具。最终回复不作为产物。`;
}
/** One message of `conversation.md`; a processed one is there only for understanding. */
export function conversationInputMessage(message) {
    return `## ${message.sessionId}/${message.messageId} ${message.at} ${message.role}${message.processed ? ' 已处理，只供理解' : ''}\n${message.text}\n`;
}
/** A tool event of the conversation, cut to a line. */
export function conversationToolEvent(toolName, text) {
    return `[工具调用] ${toolName} ${text}`;
}
// Memory file format errors (bunny/memory/format.ts, file-store.ts).
export function memoryFormatError(diskName, reason) {
    return `记忆文件 memory/${diskName} 格式不对：${reason}`;
}
export const MEMORY_STATE_BROKEN = 'Bunny 的记忆状态文件 .memory-state.json 损坏了，暂时记不住新内容。请打开 Bunny 设置 > 记忆，点“修复记忆”旁的“修复”，会按 memory/memory.md 重建，记忆内容不变。';
const META_EXAMPLE = '“  依据：用户原话 · 出处：mvs_main/msg_1 · 支持 1 次 · 状态：有效 · 首次 2026-10-20 · 更新 2026-10-20”';
const ENTRY_EXAMPLE = '“- [m-12] 回复先给结论”';
const FORGOTTEN_ENTRY_EXAMPLE = '“- [m-02] 会议纪要发到群里”';
const FORGOTTEN_SOURCE_EXAMPLE = '“  出处：mvs_main/msg_1 · 删除于 2026-10-31”';
/** The start of a line, short enough to quote in a message. */
function quote(line) {
    return `“${line.length > 40 ? `${line.slice(0, 40)}…` : line}”`;
}
/** An entry, by the line it starts on. */
function entryAt(line, id) {
    return `第 ${line} 行的记忆 [${id}] `;
}
/** A line, with its start quoted. */
function lineAt(line, text) {
    return `第 ${line} 行${quote(text)}`;
}
/** What is wrong with `memory.md` and how to fix it; the type list is `## 画像、## …`. */
export const MAIN_MEMORY_ERROR = {
    noType: (line, id, types) => `${entryAt(line, id)}上面没有分类标题。请在它上面加一行分类标题，如“## 倾向”；分类只能是 ${types}。`,
    noMeta: (line, id) => `${entryAt(line, id)}缺少“依据”行。请在这条记忆下面加一行：${META_EXAMPLE}。`,
    badBasis: (line, id) => `${entryAt(line, id)}的依据不对：“依据：”后面只能写 用户原话、用户确认 或 AI 推断。`,
    noStatus: (line, id) => `${entryAt(line, id)}缺少状态：请在依据行里写上“状态：有效”，状态只能是 有效、待整理 或 待确认。`,
    noSource: (line, id) => `${entryAt(line, id)}缺少来源：请在依据行里写上“出处：会话 ID/消息 ID”，如“出处：mvs_main/msg_1”。`,
    duplicateId: (line, id) => `${entryAt(line, id)}的编号和前面的记忆重复。每条记忆的编号要唯一，请换一个没用过的编号。`,
    noId: (line, text) => `${lineAt(line, text)}缺少编号。每条记忆以“- [m-编号] 内容”开头，如${ENTRY_EXAMPLE}，编号用没用过的数字。`,
    orphan: (line, text) => `${lineAt(line, text)}不属于任何一条记忆。每条记忆以“- [m-编号] 内容”开头；请把这一行并入某条记忆，或者删掉。`,
    secondExample: (line, text, id) => `${lineAt(line, text)}：记忆 [${id}] 已经有一行“例：”，每条记忆最多一行例子。`,
    secondMeta: (line, text, id) => `${lineAt(line, text)}：记忆 [${id}] 已经有一行“依据：”，请删掉多出来的一行。`,
    badLine: (line, text) => `${lineAt(line, text)}不是记忆的格式。一条记忆只有三种行：“- [m-编号] 内容”、可选的“例：……”和“依据：……”；请改成其中一种，或者删掉。`,
    badType: (line, text, types) => `第 ${line} 行的分类${quote(text)}不认识。分类只能是 ${types}。`,
};
/** What is wrong with `forgotten.md`; `title` is the file's own heading. */
export const FORGOTTEN_MEMORY_ERROR = {
    noSource: (line, id) => `${entryAt(line, id)}缺少“出处”行。请在它下面加一行：${FORGOTTEN_SOURCE_EXAMPLE}。`,
    badSource: (line, id) => `${entryAt(line, id)}缺少来源：请在“出处：”后面写上会话 ID/消息 ID，如“出处：mvs_main/msg_1”。`,
    badStart: (line, text) => `${lineAt(line, text)}的开头不对。每条删除的记忆以“- [m-编号] 内容”开头，如${FORGOTTEN_ENTRY_EXAMPLE}，下一行写${FORGOTTEN_SOURCE_EXAMPLE}；请改成这个格式，或者整行删掉。`,
    orphan: (line, text, title) => `${lineAt(line, text)}不属于任何一条删除的记忆。这个文件只有标题“${title}”和一条条删除的记忆，每条以“- [m-编号] 内容”开头；请把这一行并入某一条，或者删掉。`,
    badLine: (line, text) => `${lineAt(line, text)}不是这个文件的格式。一条删除的记忆只有两行：“- [m-编号] 内容”和下一行的“出处：……”；请改成其中一种，或者删掉。`,
    secondSource: (line, text, id) => `${lineAt(line, text)}：记忆 [${id}] 已经有一行“出处：”，请删掉多出来的一行。`,
};
/** What is wrong with a daily record file. */
export const DAILY_MEMORY_ERROR = {
    badTitle: (date) => `第 1 行应该是“# ${date}”，即这份记录的日期。`,
    badStart: (line, text) => `${lineAt(line, text)}的开头不对。每条记录以“- [d-月日-序号] 分类 · 依据 · 状态”开头，如“- [d-1021-01] 做法 · 用户原话 · 待观察”。`,
    badType: (line, id, type) => `第 ${line} 行的记录 [${id}] 分类${quote(type)}不对：分类只能是 画像、倾向、做法 或 去处。`,
    badBasis: (line, id, basis) => `第 ${line} 行的记录 [${id}] 依据${quote(basis)}不对：依据只能是 用户原话、用户确认 或 AI 推断，后面不加说明。`,
    badStatus: (line, id, status) => `第 ${line} 行的记录 [${id}] 状态${quote(status)}不对：日报的状态只能是 待观察、支持 m-xx、反对 m-xx、已晋升 m-xx 或 不再成立。“有效”“待整理”“待确认”是主记忆条目的状态，日报不用。`,
    duplicateId: (line, id) => `第 ${line} 行的记录 [${id}] 编号重复，请换一个没用过的序号。`,
    missingFields: (line, id, fields) => `第 ${line} 行的记录 [${id}] 缺少${fields.map((field) => `“${field}”`).join('、')}行。每条记录下面要有“现象：”“触发：”“期待：”“出处：”四行，每行前面空两格。`,
    noSource: (line, id) => `第 ${line} 行的记录 [${id}] 缺少来源：请在“出处：”后面写上会话 ID/消息 ID，如“出处：mvs_main/msg_1”。`,
};
/** One entry alone does not fit the main memory, whatever is evicted; the write is refused. */
export function memoryEntryTooLarge(input) {
    return `记忆 [${input.id}] 单条就有 ${input.tokens} token，超过主记忆的上限 ${input.limit} token，这次没有写入。请把它缩短到 ${input.limit} token 以内再写。`;
}
/**
 * A memory model's file write that broke the format or a rule: the file is saved as written,
 * and the run is discarded unless the model fixes it before it ends.
 */
export function memoryWriteInvalid(path, reason) {
    return `已写入 ${path}，但没有通过校验：${reason}\n请在这次任务里改正。任务结束时仍不通过，这次的全部改动作废。`;
}
/**
 * The consolidator's MEMORY.md is over the limit after a write: it can still merge; whatever is
 * over at the end leaves oldest first.
 */
export function memoryOverLimitNotice(path, tokens, limit) {
    return `已写入 ${path}。MEMORY.md 现在 ${tokens} token，超过上限 ${limit} token。请先合并同类条目；任务结束时仍超出，系统按更新日期从最旧的条目开始移出主记忆。`;
}
/** A file the memory directory does not hold, or one too large to keep. */
export const MEMORY_FILE_ERROR = {
    notMemory: '这不是 Bunny 的记忆文件。记忆目录里只有 memory.md、forgotten.md 和 daily/年/月/日.md。',
    tooLarge: '文件超过 2 MB，请删掉一些内容再保存。',
};
//# sourceMappingURL=memory-model.js.map