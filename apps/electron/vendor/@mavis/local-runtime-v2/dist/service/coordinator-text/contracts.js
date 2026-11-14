/**
 * The tags, field labels and data escape of the coordinator's runtime text, shared by the
 * code that writes a block and the code that finds it again.
 *
 * Readers: Bunny's main conversation (state block, task reports, memory, handoff header), its
 * task sessions (execution reminder), its compaction model (five section headings) and the
 * conversation search index (task reports). Each tag and each pattern that parses one is
 * defined here once; the blocks themselves are put together in `initialize.ts`.
 */
/** A runtime reminder inside a user message. */
export const SYSTEM_REMINDER_OPEN = '<system-reminder>';
export const SYSTEM_REMINDER_CLOSE = '</system-reminder>';
/** The coordinator's state block, `full` or `delta`, opening every Turn. */
export const MCODE_STATE_TAG = 'mcode-state';
/** The handoff header at the start of a compacted main conversation. */
export const BUNNY_HANDOFF_OPEN = '<bunny-handoff>';
export const BUNNY_HANDOFF_CLOSE = '</bunny-handoff>';
/** Bunny's long-term memory at the end of its system prompt. */
export const BUNNY_MEMORY_TAG = 'bunny-memory';
/** One finished task round reported to the coordinator; a delivery may carry several. */
export const TASK_REPORT_OPEN = '<task-report>';
export const TASK_REPORT_CLOSE = '</task-report>';
/** Line labels of a `<task-report>`, written by the report and read back by its parsers. */
export const TASK_REPORT_FIELDS = {
    task: '任务：',
    sessionId: '会话 ID：',
    status: '状态：',
    goal: '目标：',
    criteria: '完成标准：',
    finalReply: '最终回复：',
    files: '交付的文件：',
};
/** The status of a round that ended normally. */
export const TASK_REPORT_DONE_STATUS = '已结束';
/** The status of a round someone or something stopped before it finished. */
export const TASK_REPORT_STOPPED_STATUS = '已中断（这一轮没跑完就被停止）';
const TASK_REPORT_PATTERN = /<task-report>([\s\S]*?)<\/task-report>/gu;
const REPORT_SESSION_ID = /会话 ID：([^）)\s]+)/u;
const REPORT_TITLE = /^任务：(.+?)（/mu;
const REPORT_STATUS = /^状态：(.+)$/mu;
/** True when the text carries at least one task report. */
export function hasTaskReport(text) {
    return text.includes(TASK_REPORT_OPEN);
}
/** The body of every `<task-report>` in the text, in order. */
export function taskReportBodies(text) {
    return [...text.matchAll(TASK_REPORT_PATTERN)].map(([, body = '']) => body);
}
export function readTaskReport(body) {
    const sessionId = REPORT_SESSION_ID.exec(body)?.[1];
    const title = REPORT_TITLE.exec(body)?.[1]?.trim();
    const status = REPORT_STATUS.exec(body)?.[1]?.trim();
    return {
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(title === undefined ? {} : { title }),
        ...(status === undefined ? {} : { status }),
        goal: reportGoal(body),
    };
}
function reportGoal(body) {
    const lines = body.split('\n');
    const start = lines.findIndex((line) => line.startsWith(TASK_REPORT_FIELDS.goal));
    if (start < 0)
        return '';
    const end = lines.findIndex((line, index) => index > start && line.startsWith(TASK_REPORT_FIELDS.criteria));
    const goal = lines
        .slice(start, end < 0 ? start + 1 : end)
        .join('\n')
        .slice(TASK_REPORT_FIELDS.goal.length);
    return unescapeAssignmentData(goal).trim();
}
/**
 * Escapes user and model data written inside a coordinator tag, so the data cannot open or
 * close a tag of its own.
 */
export function escapeAssignmentData(value) {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function unescapeAssignmentData(value) {
    return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
/** Section headings of the compaction model's handoff summary, in protocol order. */
export const SEGMENT_SUMMARY_HEADINGS = [
    '目标与当前话题',
    '进行中的事与下一步',
    '刚完成的事',
    '等待中的事',
    '检索线索',
];
/** The goal line of the system's own space, in the state block and in the handoff header. */
export const SYSTEM_SPACE_GOAL = '系统自带，没有目标';
//# sourceMappingURL=contracts.js.map