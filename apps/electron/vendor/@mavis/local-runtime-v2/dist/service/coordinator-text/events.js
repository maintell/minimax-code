/**
 * Reader: Bunny's main conversation model.
 * Injected: as the event message that wakes a Turn (a delivery of `<task-report>`s when task
 * rounds end; the text of a Bunny schedule), and inside a Turn as the round-budget reminder
 * steered in on the third counted round, or the refusal once the budget is spent.
 * Cache: the event message and a steered reminder are written into canonical history, so later
 * requests read them from the cached prefix; a refusal is the result of the refused call.
 */
import { TASK_REPORT_DONE_STATUS, TASK_REPORT_FIELDS, TASK_REPORT_STOPPED_STATUS, } from './contracts.js';
import { taskReportBlock, wrapSystemReminder } from './initialize.js';
// Task reports (assignment/orchestration/report.service.ts).
/** A final reply up to this size enters the review turn whole. */
export const FULL_REPLY_TOKENS = 4_000;
/** Each end of a longer reply's preview. */
export const PREVIEW_EDGE_TOKENS = 800;
const ROUND_INITIATOR = {
    assigner: '发起：你派的一轮',
    user: '发起：用户在任务会话里发起的一轮。不算批准，不用核对；正常结束的，任务已按“用户完成”关闭',
};
export function renderTaskReport(report) {
    const field = TASK_REPORT_FIELDS;
    return taskReportBlock([
        `${field.task}${report.title}（${report.spaceName ? `${report.spaceName} · ` : ''}${report.projectName}，${field.sessionId}${report.sessionId}）`,
        ROUND_INITIATOR[report.initiator],
        report.error === undefined
            ? `${field.status}${report.stopped ? TASK_REPORT_STOPPED_STATUS : TASK_REPORT_DONE_STATUS}`
            : `${field.status}出错：${report.error}`,
        `${field.goal}${report.goal}`,
        field.criteria,
        ...report.criteria.map((criterion) => `- ${criterion}`),
        field.finalReply,
        ...report.finalReply,
        ...(report.files.length ? [field.files, ...report.files.map((path) => `- ${path}`)] : []),
    ]);
}
/** The line between the head and the tail of a long final reply's preview. */
export function replyOmissionLine(omittedTokens) {
    return `……（中间省略约 ${String(omittedTokens)} token）……`;
}
/**
 * The note after a preview: where the full reply is and how to read it, on a Turn with
 * run_code (its `tools.session_messages` child) and on one without (`mcp_invoke`).
 */
export function replyPreviewNote(totalTokens, sessionId) {
    return `（最终回复约 ${String(totalTokens)} token，这里只有首尾预览。读全文用 session_id：${sessionId}：有 run_code 的回合在 run_code 里 await tools.session_messages(...)，其他回合用 mcp_invoke 调 session_messages（tool_name 写 session_messages）；回复太长时按返回的 offset 分段读到结尾。读完全文再核对。）`;
}
/**
 * Why a task's round failed when the app's restart cut it off: its status shows it, and Bunny
 * gets the round back with it as a failed round.
 */
export const ROUND_INTERRUPTED_BY_RESTART = '这一轮被应用重启打断';
/**
 * Why a task's round failed, for a failure the model service reported. A task report and the
 * state block show this instead of the provider's words, so Bunny's context does not fill with
 * long English errors on Turns no user message started. Each reason keeps
 * what Bunny's retry rules need: temporary or not, and whether the user has to act.
 */
export const TASK_ERROR_REASON = {
    refusal: '模型服务拒绝处理这一轮的请求（安全策略拦截），原样重试通常还会被拒',
    refusalCooldown: '模型服务在上一次拒绝后暂停受理，过一会儿才能重试',
    busy: '模型服务繁忙或限流，属于临时故障',
    quota: '模型用量额度已用完，需要用户处理',
    auth: '模型服务认证失败，需要用户检查登录或模型密钥',
    network: '连接模型服务超时或网络中断，属于临时故障',
    server: '模型服务内部出错，属于临时故障',
    tooLong: '对话内容太多，模型无法继续处理这一轮',
    outputLimit: '模型输出达到长度上限，这一轮没写完',
    notFound: '找不到所选的模型或服务',
    badRequest: '模型服务不接受这次请求的格式或参数',
    aborted: '这一轮被中止',
};
/** Why a review gave up; the first line of the reason, written for the user. */
export const REVIEW_STOPPED = '核对被停止';
export const REVIEW_FAILURE_CAUSE = {
    restart: '应用重启打断了核对',
    timeout: '核对超时',
    failed: '核对时模型或服务出错',
};
/**
 * Why a dispatched review stopped holding a task's conclusion. Each is one line written for
 * the user, and each is followed by VERDICT_REVIEW_RELEASED so the way out is always said.
 */
export const VERDICT_REVIEW_GAVE_UP = {
    missing: '核对任务已经不在了',
    closed: '核对任务已被关闭',
    failed: '核对任务出错，没能给出结论',
    stopped: '核对任务被停止，没能给出结论',
    switchedOff: '等待核对已被关闭，这个任务不再等核对结论',
};
/** The same, for a review that ran past its deadline without reporting. */
export function verdictReviewTimedOut(minutes) {
    return `核对任务超过 ${String(minutes)} 分钟没有给出结论`;
}
/**
 * The same, for a review that did report and whose verdict no coordinator turn ever read.
 *
 * The verdict is not thrown away and the task is not concluded by it: closing a task takes
 * Bunny's confirmation, and that stays true on this path too. The gate opens so the user is
 * not left waiting behind it, with the verdict kept as the evidence of what the review found.
 */
export function verdictUnreadTimedOut(minutes) {
    return `核对结论已经存下，但超过 ${String(minutes)} 分钟没有人读取`;
}
/**
 * What can still happen to a task once the gate is released; appended to every give-up reason.
 *
 * Written for both of its readers, because both act on it. The user can close the task from
 * the panel; a coordinator turn cannot — `assignment_summary` and `assignment_claim_verdict`
 * both refuse a task whose review link is gone, and only `setCompletion({ by: 'user' })`,
 * which no Agent tool reaches, closes it. This used to promise "you can conclude it directly",
 * which is true for the user and false for Bunny: every coordinator that believed it walked
 * into two refusals and could only hand the task back to the user anyway. So the way out is
 * named for whoever can actually take it.
 */
export const VERDICT_REVIEW_RELEASED = '这个任务已解除等待核对：Bunny 已不能直接结案，只能由用户在界面上标记完成，或者重新给它派活返工。';
export function reviewGaveUp(cause, retries) {
    return `${cause}，自动重试 ${String(retries)} 次仍没完成`;
}
// The round budget and review delivery follow-up (bunny/round-budget.ts).
const TURN_ONLY_REMINDER = 'This reminder applies only to the current Turn. Do not save or generalize it.';
const FREE_CALLS = '派任务（assignment_create，含 run_code 里调用）、续派返工（assignment_send）、结案（assignment_summary）、send_to_user、新建事项，以及记忆、账本、定时、设置、context.md 的写入命令本身不计轮次';
export function roundBudgetReminder(rounds, blockAt) {
    const limit = blockAt === undefined ? '' : `从第 ${blockAt} 轮起，计数的工具调用会被拒绝。`;
    return wrapSystemReminder([
        `本轮对话已用 ${rounds} 轮计数的工具调用（计法同 <dispatch>）。按 <dispatch>，下一步应派任务（assignment_create），不再自己查；“再查一步就清楚了”也按超过算。${FREE_CALLS}。${limit}`,
        TURN_ONLY_REMINDER,
    ]);
}
export function reviewRoundBudgetReminder(rounds, blockAt) {
    const limit = blockAt === undefined ? '' : `从第 ${blockAt} 轮起，计数的工具调用会被拒绝。`;
    return wrapSystemReminder([
        `本轮核对已用 ${rounds} 轮计数的工具调用（计法同 <dispatch>，<results> 上限为 3 轮）。核对通过请用 assignment_summary 记下结论并用 send_to_user 交付用户；没通过或证据不足请用 assignment_send 发回原任务（或派 verifier 子 Agent 核对），不再在主对话里继续自查。${FREE_CALLS}。${limit}`,
        TURN_ONLY_REMINDER,
    ]);
}
export function roundBudgetRefusal(rounds, blockAt) {
    return `本轮对话已用 ${rounds} 轮计数的工具调用，从第 ${blockAt} 轮起不再自己查。请派任务（assignment_create）、发回原任务（assignment_send）、结案（assignment_summary），或用 send_to_user 告诉用户现状。${FREE_CALLS}，不受这条限制。`;
}
/**
 * Asked once when a coordinator Turn concludes a reviewed task (explicitly via
 * `assignment_summary`, or implicitly by leaving an open review to auto-close on finish)
 * without delivering anything through `send_to_user`.
 */
export const REVIEW_CONCLUDED_WITHOUT_DELIVERY_FOLLOW_UP = wrapSystemReminder([
    '这一轮你已经核对结案了任务（或本轮结束时未发回的任务将自动标为已完成），但还没有调用 send_to_user，用户看不到任何结论或交付文件。请用 send_to_user 把结果（需要交付文件时附上 <deliver-assets>）发给用户，最后一条可带 end_turn=true（context.md 已写过则不必重写）；如果任务还没通过核对，请改用 assignment_send 发回原任务。确实不需要通知用户时，只回复“无”结束本轮。',
    TURN_ONLY_REMINDER,
]);
// A Bunny schedule (bunny/orchestration/schedule-space-label.ts).
/** The line naming the space a schedule belongs to, before the schedule's own text. */
export function scheduleSpacePrefix(spaceName) {
    return `事项：${spaceName}\n\n`;
}
/** A schedule whose space was deleted names it so instead of by its raw ID. */
export function deletedScheduleSpace(spaceId) {
    return `已删除（${spaceId}）`;
}
//# sourceMappingURL=events.js.map