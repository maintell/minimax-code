/**
 * Reader: Bunny's main conversation model.
 * Injected: the state block opening every Turn, right after the `<wake>` line: the full state
 * when the session has no delivered baseline (the first Turn, after every compaction), else
 * only what changed outside Bunny's own actions. The compaction handoff header reuses the task
 * rows and the ledger section.
 * Cache: written into canonical history as a hidden message before the Turn's user or event
 * message, so later requests read it from the cached prefix.
 *
 * Bunny's memory (the last section) is read at the end of the system prompt instead, rebuilt
 * when the memory files change, so it is part of the cached system prefix.
 */
import { SYSTEM_SPACE_GOAL } from './contracts.js';
// The block's sections and its own lines.
export const STATE_SECTIONS = {
    tasks: '任务：',
    ledger: '近期约定：',
    contexts: '空间 context.md：',
    spaces: '任务空间：',
    projects: '近期项目：',
};
/** An empty list. */
export const STATE_NONE = '无';
/** The line a block carries when the view read took longer than its cap. */
export const STALE_STATE_LINE = '状态可能滞后';
/** The line a part of the block that could not be read writes in its place. */
const STATE_UNREADABLE_LINE = {
    task_view: '任务：这一轮读不出，读得出后补上',
    previous_turn_start: '上一轮开始时间：这一轮读不出',
    space_list: '任务空间列表：这一轮读不出，读得出后补上',
    ledger: '近期约定：账本暂时读不出，读得出后补上；需要时用 working_state list 读现行条目',
    overview: '任务空间和近期项目：这一轮读不出，读得出后补上',
    ui_view: '界面：这一轮读不出',
    recall_precheck: '可能相关的早前对话：这一轮读不出，需要时用 conversation_search 查',
    space_context: '空间 context.md：这一轮读不出，读得出后补上',
    reminders: '提醒：这一轮读不出，读得出后补上',
    memory: '记忆：这一轮读不出，读得出后补上',
};
/** That line, naming the entries of the part that could not be read when `detail` is given. */
export function stateUnreadableLine(item, detail) {
    const line = STATE_UNREADABLE_LINE[item];
    return detail ? line.replace('：', `：${detail} `) : line;
}
export function stateTimeLine(nowMs, previousStartMs) {
    const since = previousStartMs === undefined ? '' : `，距上一轮 ${stateAge(nowMs - previousStartMs)}`;
    return `现在：${stateLocalTime(nowMs)}${since}`;
}
export function panelViewLine(view, nowMs) {
    if (!view)
        return '界面：未知';
    const prefix = `界面（${stateAge(nowMs - view.reportedAtMs)}前上报）：`;
    if (!view.panelOpen)
        return `${prefix}Bunny 面板未打开`;
    const space = view.spaceName === undefined ? '全部' : ` ${view.spaceName}`;
    return `${prefix}Bunny 面板已打开，打开的任务空间是${space}`;
}
export function spaceOverviewLine(space) {
    const open = space.openTasks === undefined ? '' : `未结束的任务 ${String(space.openTasks)} 个`;
    return `- ${space.name}（${space.id}）：${spaceDetail(space)}${open}`;
}
function spaceDetail(space) {
    if (space.system)
        return `${SYSTEM_SPACE_GOAL}。`;
    const goal = space.goal ? `目标是${space.goal}。` : '没有目标。';
    const projects = space.projects.length ? space.projects.join('、') : STATE_NONE;
    return `${goal}关联项目：${projects}。`;
}
export function recentProjectLine(name, dir, idleMs) {
    return `- ${name}  ${dir}  ${stateAge(idleMs)}前`;
}
function stateAge(ms) {
    const minutes = Math.max(0, Math.floor(ms / 60_000));
    if (minutes < 60)
        return `${String(minutes)} 分钟`;
    if (minutes < 1440)
        return `${String(Math.floor(minutes / 60))} 小时`;
    return `${String(Math.floor(minutes / 1440))} 天`;
}
function stateLocalTime(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 周${'日一二三四五六'[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// Task rows (assignment/state/task-delta.ts, assignment/orchestration/snapshot.service.ts).
/** A task row: its label, then its escaped parts. */
export function taskRow(label, parts) {
    return `- [${label}] ${parts.join(' · ')}`;
}
export const TASK_STOPPED_DETAIL = '已停止';
export function taskTakenOverDetail(successorSessionId) {
    return `由任务 ${successorSessionId} 接手`;
}
/** How a row names each way a task closes. */
export const TASK_CLOSURE_LABEL = {
    review_passed: '已关闭（核对后结案）',
    user_marked: '已关闭（用户标记完成）',
    user_round: '已关闭（用户完成）',
    cancelled: '已取消',
    taken_over: '已关闭（被接手）',
    stalled: '已关闭（工具调用挂住，保留已产出）',
};
export const TASK_CLOSED_LABEL = '已关闭';
export const TASK_CATEGORY_LABEL = {
    attention: '等你处理',
    error: '出错',
    ended: '刚结束',
    running: '进行中',
};
/** A row for a task leaving a state, and the label of each state a task can be in. */
export const TASK_STATE_LABEL = {
    recovered: '已处理，恢复进行中',
    unstalled: '有新进展，不再停滞',
    waitingApproval: '等你批准',
    failed: '出错',
    reviewFailed: '核对出错',
    attention: '等你处理',
    queued: '排队中',
    running: '进行中',
    stalled: '进行中 · 停滞',
    reviewing: '核对中',
};
export function taskRemovedRow(sessionId) {
    return `- [${TASK_CLOSED_LABEL}] ${sessionId}（任务已归档或删除）`;
}
/** The changed tasks a block only counts, by category label. */
export function taskCountLine(total, categories) {
    const parts = categories.map(({ label, count }) => `${label} ${String(count)} 个`);
    return `另有 ${String(total)} 个任务变化未列出（${parts.join('，')}），之后几轮补上`;
}
/** Why a running task counts as stalled (assignment/orchestration/activity.service.ts). */
export function stallRepeatedError(firstLine) {
    return `同样的错误连续出现 3 次：${firstLine}`;
}
export const STALL_NO_PROGRESS = '10 分钟没有进展';
/** The round's own work never came back and the task was closed for it. */
export function stallHungWork(minutes) {
    return `工具调用或后台任务超过 ${minutes} 分钟没有返回，任务已收口并保留已产出内容`;
}
// The user's context.md edits (assignment/state/context-delta.ts); every text comes escaped.
/** The heading a change before the first `## ` section is named by. */
export const CONTEXT_PREAMBLE_HEADING = '开头';
export function contextRevisionLine(space, revision, changedSections) {
    const head = `- 空间 ${contextSpaceName(space)}的 context.md 被改过（新版本 ${revision.slice(0, 8)}）`;
    return changedSections.length ? `${head}，改了：${changedSections.join('、')}` : head;
}
export function contextGoalLine(space, goal) {
    return `- 空间 ${contextSpaceName(space)}的目标改为：${goal || STATE_NONE}`;
}
function contextSpaceName(space) {
    return `${space.name}（${space.id}）`;
}
const KIND_LABEL = {
    correction: '纠正',
    constraint: '约束',
    open_question: '待答问题',
    context_gap: '待写进 context.md 的决定',
};
const CLOSE_LABEL = {
    done: '已完成',
    answered: '已回答',
    withdrawn: '已撤回',
    expired: '已到期',
};
/** Header sections in injection order. */
const SECTIONS = [
    { title: '纠正与约束', kinds: ['correction', 'constraint'] },
    { title: '待答问题', kinds: ['open_question'] },
    { title: '待写进 context.md 的决定', kinds: ['context_gap'] },
];
/** What the closing note is, by close reason. */
const NOTE_LABEL = {
    done: '说明',
    answered: '回答',
    withdrawn: '撤回原因',
    expired: '说明',
};
const CLOSED_BY = {
    user: '用户关闭',
    system: '到期自动关闭',
    compactor: '整理对话时关闭',
    front: '你关闭',
};
export function ledgerLocalTime(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function closeNote(entry) {
    return entry.status === 'done' && entry.closeNote
        ? `${NOTE_LABEL[entry.closeReason ?? 'done']}：${entry.closeNote}`
        : '';
}
function closedMark(entry) {
    return entry.status === 'done'
        ? `【已关闭：${entry.closeReason ? CLOSE_LABEL[entry.closeReason] : CLOSE_LABEL.done}】`
        : '';
}
/** One entry as the model reads it: ID, kind, text and the fields that change how to act. */
function formatLedgerEntry(entry) {
    const details = [
        closeNote(entry),
        entry.scope === 'global' ? '' : `空间 ${entry.scope.slice('space:'.length)}`,
        entry.replaces ? `不要再：${entry.replaces}` : '',
        entry.expiresAtMs === undefined ? '' : `到期 ${ledgerLocalTime(entry.expiresAtMs)}`,
        entry.inferred ? '推断' : '',
    ].filter(Boolean);
    return `[${entry.id}] ${closedMark(entry)}${KIND_LABEL[entry.kind]}：${entry.text}${details.length ? `（${details.join('；')}）` : ''}`;
}
function sectionLines(entries) {
    const lines = [];
    for (const section of SECTIONS) {
        const items = entries.filter((entry) => section.kinds.includes(entry.kind));
        if (!items.length)
            continue;
        lines.push(`${section.title}：`, ...items.map((entry) => `- ${formatLedgerEntry(entry)}`));
    }
    return lines;
}
/** The ledger section of a handoff header, with the count of entries cut for its share. */
export function ledgerHeaderText(entries, truncated) {
    if (!entries.length && !truncated)
        return '近期约定：无。';
    return [
        '近期约定（工作状态账本，按现行版本执行）：',
        ...sectionLines(entries),
        ...(truncated ? [ledgerOmittedLine(truncated)] : []),
    ].join('\n');
}
/** The line that stands for ledger entries cut for length, in a header or a full block. */
export function ledgerOmittedLine(count) {
    return `另有 ${count} 条因篇幅没有列出，用 working_state list 读全。`;
}
/** An entry's line in a state block; a full block lists it as it stands. */
export function ledgerDeltaLine(entry, full) {
    if (entry.status === 'superseded')
        return undefined;
    if (full)
        return `- ${formatLedgerEntry(entry)}`;
    if (entry.status === 'done') {
        const note = closeNote(entry);
        return `- [${entry.id}] ${CLOSED_BY[entry.updatedBy]}（${entry.closeReason ? CLOSE_LABEL[entry.closeReason] : CLOSE_LABEL.done}）：${entry.text}${note ? `（${note}）` : ''}`;
    }
    if (entry.updatedBy === 'compactor')
        return `- 整理对话时写入 ${formatLedgerEntry(entry)}`;
    const verb = entry.supersedes ? `用户修改（替代 ${entry.supersedes}）` : '用户新增';
    return `- ${verb} ${formatLedgerEntry(entry)}`;
}
// Recall pointers (bunny/conversation-search/precheck.ts); the heading stays with the
// AgentHost, which writes and recognises the pointer message.
export function recallPointerLine(pointer) {
    return `- [${pointer.messageId}] ${pointer.time} ${pointer.snippet}`;
}
// Bunny's memory at the end of the system prompt (bunny/memory/format.ts).
/** One remembered entry; `basis` says how it was learned. */
export function memoryInjectionLine(entry) {
    return `- ${entry.content}${entry.example ? ` 例：${entry.example}` : ''}（${entry.basis}${entry.repeated ? '，多次' : ''}）`;
}
export function memoryInjectionGroup(type, lines) {
    return `${type}\n${lines.join('\n')}`;
}
/** Where the details behind the injected memory are. */
export const MEMORY_INJECTION_TAIL = '这里只有已经确认的条目；还没确认的条目、细节和出处在 memory/memory.md 和 memory/daily/YYYY/MM/DD.md，需要时用 grep 和 read 查。';
//# sourceMappingURL=state-block.js.map