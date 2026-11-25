import { escapeAssignmentData } from '../../coordinator-text/index.js';
import { goalStatusOf } from '../../session-system/index.js';
import { VERDICT_CLAIM_TOOL } from './verdict-gate.js';
/**
 * One stored verdict as the assigner's wake Turn reads it: what the review concluded,
 * what it cited, and that concluding the task still takes an explicit conclusion.
 */
export function renderVerdictNotice(input) {
    const { sessionId, verdict } = input;
    const safe = escapeAssignmentData;
    const head = `<verdict-notice task="${safe(sessionId)}" revision="${String(verdict.revision)}" source="${safe(verdict.source)}">`;
    const out = [
        head,
        `核对结论：${safe(verdict.outcome)}（目标状态：${safe(goalStatusOf(verdict))}）`,
    ];
    if (verdict.parseFailed)
        out.push('这份核对输出不是结构化结论，已按 partial 记录；请自己读任务结果再判断。');
    if (verdict.summary)
        out.push(`核对摘要：${safe(verdict.summary)}`);
    if (verdict.evidence.length) {
        out.push('核对引用的证据：');
        for (const item of verdict.evidence)
            out.push(`- [${safe(item.kind)}] ${safe(item.ref)}${item.detail ? ` — ${safe(item.detail)}` : ''}`);
    }
    out.push(`这条通知不代表你读过：先用 ${VERDICT_CLAIM_TOOL}（session_id=${safe(sessionId)}）把这份结论读进这一轮。`, '读完再决定：认同就用 assignment_summary 结案；不认同就 assignment_send 返工。', '结案仍然只认你的结论，这份 verdict 本身不会结案；没领过它，assignment_summary 会拒绝你。', '</verdict-notice>');
    return out.join('\n');
}
//# sourceMappingURL=verdict-notice.js.map