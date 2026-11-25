/**
 * Reader: the model of a task session Bunny assigned.
 * Injected: the task's first user message when Bunny dispatches it; the execution reminder on
 * every request of the task's Turns; a refusal as the result of a call the task may not make.
 * Cache: the first message is the start of the task's history and its cached prefix. The
 * execution reminder is request-only: it is added to each request and never written into
 * history, so it sits after the cached prefix. A refusal is written into history after the call.
 * The reminder points back to the first message for the goal and the user's words, and restates
 * only the criteria, which compaction may otherwise drop.
 */
import { wrapSystemReminder } from './initialize.js';
import { ledgerLocalTime } from './state-block.js';
// The first message (assignment/orchestration/assignment.service.ts).
/**
 * Below this many non-whitespace characters, finding the user's words inside the brief is
 * coincidence rather than a quotation of them (a bare "好。" in prose, a test's "U"). Repeating
 * such a phrase costs nothing, while dropping the block would cost the task its labelled copy.
 */
const MIN_QUOTED_USER_WORDS = 4;
/** Bunny's instruction, the done-when criteria, then the user's own words quoted line by line. */
export function renderTaskFirstMessage(input) {
    const quoted = input.userWords
        .trim()
        .split('\n')
        .map((line) => `> ${line}`.trimEnd())
        .join('\n');
    const doneWhen = input.criteria.length
        ? `\n\n完成标准：\n${input.criteria.map((item) => `- ${item}`).join('\n')}`
        : '';
    const brief = `${input.content}${doneWhen}`;
    // The prompt tells Bunny the words are appended and must not be quoted again in `content`
    // (<brief>), but a model that quotes them anyway used to hand the task the same sentence
    // twice. They are already in the message, so the block is dropped rather than added again:
    // the task reads the user's own words exactly once, whichever way Bunny wrote the brief.
    return alreadyQuotes(brief, input.userWords) ? brief : `${brief}\n\n用户原话：\n${quoted}`;
}
/** Whether `text` already carries `userWords` in full, ignoring where the line breaks fall. */
function alreadyQuotes(text, userWords) {
    const needle = withoutWhitespace(userWords);
    return needle.length >= MIN_QUOTED_USER_WORDS && withoutWhitespace(text).includes(needle);
}
function withoutWhitespace(value) {
    return value.replace(/\s+/gu, '');
}
/**
 * Appended to a queued task's first message when some of the files it was dispatched with can no
 * longer be read by the time it starts (assignment/orchestration/assignment-queue.ts). Empty when
 * every file is there, so the message is then exactly the one an immediate start sends.
 */
export function missingTaskAttachments(paths) {
    if (!paths.length)
        return '';
    return `\n\n派出时附带的这些文件，在任务开始时已经读不到，没能附上：\n${paths
        .map((path) => `- ${path}`)
        .join('\n')}\n需要它们才能做的部分，在回复里写明缺了哪个文件。`;
}
// The execution reminder (assignment/execution-reminder.ts); every text comes escaped.
const TASK_BRIEF_POINTER = '本任务的目标和用户的原话，都已逐字写在本会话的第一条消息里：需要哪一条就回看那条消息的原文，不要凭记忆改写或省略。';
/** Preserve completion criteria even after history compaction. */
function taskCriteriaBlock(criteria) {
    const items = criteria.map((item) => item.trim()).filter(Boolean);
    if (!items.length)
        return [];
    return ['', '完成标准（以此为准，逐条核对）：', ...items.map((item) => `- ${item}`)];
}
export function renderExecutionReminder(reminder) {
    return wrapSystemReminder([
        '这是 Bunny 安排的任务。Bunny 是用户的协作管家，你的结果会自动送回给它核对。',
        '',
        ...(reminder.spaceName ? [`所属事项：${reminder.spaceName}`] : []),
        ...(reminder.overallGoal ? [`整体目标：${reminder.overallGoal}`] : []),
        ...(reminder.conventions ? [`事项约定：${reminder.conventions}`] : []),
        ...(reminder.excerpt ? ['', '事项简报（context.md 摘录）：', reminder.excerpt] : []),
        ...(reminder.constraints.length ? ['', ...reminder.constraints] : []),
        ...(reminder.spaceDir
            ? [
                `事项目录：${reminder.spaceDir}。context.md 记录目标和现状，artifacts/ 放各任务的文件；context.md、meta.json 只读，由 Bunny 维护。`,
            ]
            : []),
        '',
        TASK_BRIEF_POINTER,
        ...taskCriteriaBlock(reminder.criteria ?? []),
        '',
        '执行约定：',
        workingDirectoryRule(reminder.workingDirectory),
        '- 推送代码、建 PR 或 MR、给别人发消息或邮件、写删工作目录以外的文件、删除分支、会话或数据、对外发布：做之前停下，用 ask_user 请用户决定。',
        '- 登录、付款、输入凭据或密钥：请用户本人完成，不索要密码、验证码或密钥。',
        '- 缺少需要的东西（文件、权限、账号、接口）：在回复里写明缺什么，然后停下，不替代、不模拟、不猜。',
        '- 需要时可以用你自己的子 Agent。',
        '- 结束时最后一条回复先写结论，再用 <deliver-assets> 列出交付的文件，最后写你怎么验证的。',
    ]);
}
/**
 * Where the task's files go. A project task is told its execution directory, and whether that
 * is a worktree of its own or the user's project itself.
 */
function workingDirectoryRule(directory) {
    if (!directory)
        return '- 文件放在你当前的工作目录里，遵守项目自己的规则。';
    if (directory.worktree)
        return `- 执行目录：${directory.dir}，是这个项目给你的独立工作树，不影响用户的主工作区。文件放在这里，遵守项目自己的规则。`;
    return `- 执行目录：${directory.dir}，就是用户的项目目录本身，没有独立工作树：你的改动直接落在用户的项目文件上。文件放在这里，遵守项目自己的规则。只读的任务照常做；要修改这个仓库里已跟踪的产品代码时，先在仓库的 .worktrees/ 下自己 git worktree add 一个工作树，在里面改，不要直接改主目录；最后一条回复里写清工作树路径和分支名。`;
}
/** The global constraints of Bunny's ledger a task follows (working-state/render.ts). */
export const GLOBAL_CONSTRAINTS_TITLE = '用户的现行约束（Bunny 的近期约定）：';
export function globalConstraintLine(entry) {
    return `- ${entry.text}${entry.expiresAtMs === undefined ? '' : `（到期 ${ledgerLocalTime(entry.expiresAtMs)}）`}`;
}
// Refusals.
/** A task asked to start more work beside it (session-system/assignment-tasks/). */
export const NESTED_TASK_REFUSAL = '任务会话不能再派任务：需要拆分请用子 Agent（task 工具）在本会话内完成，或在结果里说明交给 Bunny 决定';
/** A task tried to message Bunny's conversation (session-system/session-send/). */
export const TASK_TO_COORDINATOR_REFUSAL = '任务会话不能给 Bunny 的对话发消息：这一轮结束后结果会自动回传给 Bunny，要交代的写进最终回复。';
/** A task tried to write a space's own files (assignment/permission/protected-paths.ts). */
export const PERMISSION_TASK_SPACE_FILES = '这里用不了：事项的 context.md、meta.json、data/ 和 .db/ 只由 Bunny 维护，任务里只能读。要记的决定或产出写在最后的回复里，Bunny 核对后会更新 context.md。';
//# sourceMappingURL=task-session.js.map