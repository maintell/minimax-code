/**
 * The `<review-target>` block a review task is dispatched with.
 *
 * A review sub-task cannot reach the task it checks: the verifier Agent has no session-reading
 * tools, so nothing it could call would hand it the checked task's own goal, criteria, final
 * reply or delivered files. Bunny therefore writes only what needs its judgement (what the user
 * asked for, what to look at); everything the machine can copy without misquoting it is collected
 * here and injected into the review task's first message.
 *
 * Every value comes from the checked task's own stored state, so a review never sees a
 * hand-copied version of it. The block is written only when a dispatch names `reviewOf`; a
 * dispatch without one renders exactly the first message it renders today.
 */
import { escapeAssignmentData } from '../coordinator-text/index.js';
/** The tag the block is written in; kept beside the readers that parse it back. */
export const REVIEW_TARGET_OPEN = '<review-target>';
export const REVIEW_TARGET_CLOSE = '</review-target>';
const safe = escapeAssignmentData;
/**
 * The block as the review task's first message carries it, or `''` for a target with nothing
 * recorded — a dispatch that names `reviewOf` always names a Session, so the ID is always there.
 */
export function renderReviewTarget(target) {
    const lines = [REVIEW_TARGET_OPEN, `会话 ID：${safe(target.sessionId)}`];
    appendScalar(lines, '回传 report_key', target.reportKey);
    appendScalar(lines, '核对轮次 turn_id', target.roundTurnId);
    if (target.materialsUnavailable)
        lines.push('回传内容：不可用（未能定位该 report_key 对应的轮次；未注入任何其他轮次的回复或文件）');
    appendScalar(lines, '目标', target.goal);
    appendBlock(lines, '完成标准', criteriaLines(target.doneWhen));
    appendBlock(lines, '最终回复', replyLines(target.finalReply));
    appendBlock(lines, '交付的文件', fileLines(target.files));
    appendBlock(lines, '用户引用与选区（user_selection_refs）', selectionRefLines(target.userSelectionRefs));
    lines.push(REVIEW_TARGET_CLOSE);
    return lines.join('\n');
}
/** One `label：value` line, or nothing when the field was never recorded. */
function appendScalar(lines, label, value) {
    if (value)
        lines.push(`${label}：${safe(value)}`);
}
/** A labelled block, or nothing at all when it would carry no line. */
function appendBlock(lines, label, rendered) {
    if (!rendered.length)
        return;
    lines.push(`${label}：`);
    for (const line of rendered)
        lines.push(line);
}
/** Done-when criteria, each trimmed; a criterion that trims away is not recorded at all. */
function criteriaLines(doneWhen) {
    return (doneWhen ?? [])
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => `- ${safe(item)}`);
}
/** The final reply's parts, verbatim; an empty part is not a line of its own. */
function replyLines(finalReply) {
    return (finalReply ?? []).filter((part) => part.length > 0).map((part) => safe(part));
}
/** Delivered file paths, each once per recorded path; a blank path is not a line of its own. */
function fileLines(files) {
    return (files ?? []).filter((file) => file.trim().length > 0).map((file) => `- ${safe(file)}`);
}
/** References that carry at least one part; one that carries none is not a reference. */
function selectionRefLines(refs) {
    return (refs ?? [])
        .filter((ref) => ref.messageId || ref.summary || ref.surface)
        .map((ref) => `- ${renderSelectionRef(ref)}`);
}
/** One reference line; every part it has, in a fixed order, so a reader can parse it back. */
function renderSelectionRef(ref) {
    const parts = [];
    if (ref.messageId)
        parts.push(`message_id=${safe(ref.messageId)}`);
    if (ref.surface)
        parts.push(`surface=${safe(ref.surface)}`);
    if (ref.summary)
        parts.push(`摘要=${safe(ref.summary)}`);
    return parts.join(' ');
}
/** The block appended to a review task's first message, or `''` when there is nothing to add. */
export function reviewTargetSection(target) {
    if (!target)
        return '';
    const rendered = renderReviewTarget(target);
    return `\n\n${rendered}`;
}
//# sourceMappingURL=review-target.js.map