/**
 * Reader: Bunny's main conversation model.
 * Injected: as the result of a tool call Bunny made: an assignment tool, a space or session
 * command, a file write the permission layer refused, a conversation search, or a command the
 * command-line runtime cannot run.
 * Cache: the result is written into canonical history after the call, so later requests read
 * it from the cached prefix.
 */
// Assignment tools (assignment/orchestration/assignment.service.ts).
export const ASSIGNMENT_ERROR = {
    sendQueued: '这个任务还在排队，等它开始后再补充；要改内容就先 assignment_cancel 再重新派',
    sendCancelled: '这个任务已取消，不能续派。要接着做，用 assignment_create 新派一个任务，把原任务做到哪、留下的文件和结论写进任务说明',
    cancelPending: '任务还在停止中，请稍后再取消',
    takeoverNotOwned: 'takes_over 只能接手 Bunny 自己派的任务',
    takeoverClosed: '原任务已经结束，不用接手；直接新派任务，把它的结论写进说明',
    takeoverPending: '原任务还在停止中，请稍后再接手',
    stopNotOwned: '只能停止 Bunny 自己派的任务',
    stopClosed: '这个任务已经结束，不用停止',
    stopQueued: '这个任务还在排队，没有在执行；不要它了就用 assignment_cancel',
    stopNotRunning: '这个任务现在没有在执行，不用停止',
    projectPathNotFound: '路径不是已登记项目或其下的现有目录，请从候选项目中选择，或传候选项目下的目录。',
    projectNotMatched: '项目未唯一匹配，请从候选项目中选择名称或路径。',
};
export function assignmentTakenOver(successorSessionId) {
    return `这个任务已被新任务（${successorSessionId ?? '未知'}）接手，不能续派；要补充就发给接手的任务`;
}
export function assignmentModelUnavailable(modelKey, reason) {
    return `任务模型 ${modelKey} 不可用，没有创建任务：${reason}`;
}
export function assignmentSpaceNotFound(wanted, spaces, defaultSpaceName) {
    return `找不到任务空间「${wanted}」。可选：${spaces.map((item) => `${item.name}（${item.id}）`).join('、')}；不指定时放进 ${defaultSpaceName}`;
}
/** Where a task runs, as the create result and its reports name it. */
export function executionLocationText(location) {
    if (location.project === undefined)
        return '空间目录';
    return `${location.project}${location.worktree ? '（工作树）' : ''}`;
}
/** A project sub-directory the task's new worktree does not have yet. */
export function worktreeSubPathMissing(subPath) {
    return `${subPath} 在工作树里不存在（可能还没提交），任务从工作树根目录开始`;
}
// Space commands (application/session/bunny-composition.ts).
export const SPACE_CONTEXT_NOTICE_HINT = 'context.md 已更新，但宿主不会替你通知。请对 openTasks 里每个受这次改动影响的任务调用 assignment_send，reason 填 decision';
export const SPACE_CREATE_NEEDS_USER = '这一轮不是用户回复唤醒的，不能新建任务空间。先用问卷向用户提议名称、目标和理由，等用户同意后，在用户回复的那一轮里再建；用户没同意就把任务放进 Bunny 的空间。';
// context.md writes (session-system/files/library/space-context.ts).
export function spaceContextConflict(revision) {
    return `context.md 已被改过，请重新读取后再写（当前版本 ${revision}）`;
}
/** The write as it would land: `current` is the summary before the write, when it was read. */
export function spaceContextTooLong(length, limit, current) {
    const now = current === undefined ? '' : `（当前 ${current} 个字符）`;
    return `summary 改完会变成 ${length} 个字符${now}，上限 ${limit}，至少要删掉 ${length - limit} 个字符`;
}
/** A background tidy may not touch a section whose entries only Bunny or the user retires. */
export function spaceContextLockedSectionChanged(heading) {
    return `整理不能改「${heading}」这一节：只有 Bunny 能删改里面的条目，整理只压缩「已定事项」「进展」「下一步」`;
}
/** A background tidy that did not shrink the summary leaves it as it was. */
export function spaceContextTidyDidNotShrink(before, after) {
    return `整理后的 summary 有 ${after} 个字符，不比原来的 ${before} 个字符短，保留原文`;
}
export const SPACE_CONTEXT_SUMMARY_TAG = 'summary 里不能出现 </summary> 标签';
// Session commands (session-system/session-send/mavis-tool-adapters.ts).
export const SESSION_FOREIGN_TARGET = 'Bunny 只能停止、修改或发消息给自己派出的任务；其他对话只读。要接着做，用 assignment_create 派一个新任务，把它的进展写进任务说明。';
// File writes the permission layer refuses (assignment/permission/).
export const PERMISSION_RUNTIME_DIRECTORY = '这里用不了：Bunny 的数据库目录 data/ 和回收站 .trash/ 只由运行时维护，不能直接写或删。';
export const PERMISSION_SPACE_CONTEXT_ARCHIVE = '这里用不了：任务空间的 context-archive.md 是系统整理 context.md 时留下的原文存档，只能读，不能写或删。要找回整理掉的内容，读出来再用 mavis space context write 写回 context.md。';
export const PERMISSION_SPACE_CONTEXT_FILE = '这里用不了：任务空间的 context.md 不能用文件工具或 bash 直接写。改现状用 mavis space context write（先 mavis space context read 拿 revision），改目标用 mavis space update 的 goal。';
/** Asks the user instead of passing automatically: the task owning the session is unknown. */
export const PERMISSION_UNKNOWN_OWNER = '读不到这个会话的任务归属，不能按自动通过处理，这一次请你确认';
// Conversation search (bunny/conversation-search/, session-system/messages/search-index/).
export const SEARCH_ERROR = {
    scope: '原文检索只用于 Bunny 当前的主对话',
    cursor: 'cursor 与这次的 query 和过滤条件不匹配；换了条件请不带 cursor 重新查询',
};
export function searchDateInvalid(key) {
    return `${key} 要用 ISO 日期或时间，例如 2026-10-01`;
}
export function searchMessageNotFound(messageId) {
    return `没有找到这条消息：${messageId}。message_id 用 conversation_search 结果里的值`;
}
// The command-line runtime (session-handoff/hosted/hosted-agent-capability-restrictions.ts).
export const CLI_REFUSAL = {
    cron: '这里用不了：命令行版暂不支持定时任务，请在桌面端设置。',
    miniapp: '这里用不了：命令行版暂不支持 Mini App，请在桌面端打开。',
};
//# sourceMappingURL=tool-results.js.map