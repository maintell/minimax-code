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
/**
 * What a review task has to end its reply with.
 *
 * `parseVerdict` reads a verdict out of the reviewer's own text and nothing else: a fenced code
 * block, else the first balanced object, carrying `outcome` (or `verdict`) in
 * `pass | fail | partial`, a `summary`, and `evidence` entries with a `ref` and an optional
 * `kind` and `detail`. Output it cannot read is still recorded, as a `partial` marked
 * `parseFailed` — but its evidence is gone, so the conclusion the assigner reads says the
 * review checked nothing. Nothing else in the runtime asks for that shape, so a review
 * dispatched without this contract reliably produces that degraded verdict.
 *
 * It rides on the review dispatch's first message, which is the one place every review task is
 * guaranteed to read: the reviewer has no tool that reaches the task it checks, and this block
 * is where the materials it may read are named.
 *
 * Only while `bunny.verdictGate` is on — see {@link reviewTargetSection}.
 */
const REVIEW_VERDICT_CONTRACT = [
    '核对结论的输出格式（这一轮的结案依据，必须遵守）：',
    '这一轮回复的最后，用一段 ```json 代码块给出你的核对结论，字段如下。系统只从这段 JSON 读结论；',
    '读不到就记成 partial 并标记「不是结构化结论」，你列的证据会全部丢失，等于没核对。',
    '{',
    '  "outcome": "pass | fail | partial",',
    '  "summary": "一句话结论",',
    '  "evidence": [',
    '    {',
    '      "kind": "file | command | output | url | other",',
    '      "ref": "路径:行号、你跑过的命令、URL 或输出位置",',
    '      "detail": "你在那里看到了什么"',
    '    }',
    '  ]',
    '}',
    'outcome 的含义：pass=达到完成标准；fail=没达到，指名道姓说出差在哪；partial=材料不足或只核对了一部分，无法判断。',
    'evidence 至少给一条你真的打开看过的东西，并写出位置；没有证据的 pass 不算核对通过。',
    '这段 JSON 决定这个任务能不能关闭，所以只写你确实核对过的内容，不要把没看过的写成看过。',
].join('\n');
/**
 * The block appended to a review task's first message, or `''` when there is nothing to add.
 *
 * `verdictGate` is `bunny.verdictGate` as the runtime gate itself reads it, and it decides
 * whether the contract rides along — not what the contract says. The contract tells the reviewer
 * that its JSON decides whether the checked task can close, which is true only while the gate is
 * installed. With the switch off nothing reads a verdict: `assignment_claim_verdict` is not
 * registered, no review link is built, and `assignment_summary` closes the checked task on its
 * own, so a review task told to produce a verdict would be writing for a reader that does not
 * exist. Off, this returns byte for byte what it returned before the contract existed.
 */
export function reviewTargetSection(target, verdictGate) {
    if (!target)
        return '';
    const rendered = renderReviewTarget(target);
    return verdictGate ? `\n\n${rendered}\n\n${REVIEW_VERDICT_CONTRACT}` : `\n\n${rendered}`;
}
//# sourceMappingURL=review-target.js.map