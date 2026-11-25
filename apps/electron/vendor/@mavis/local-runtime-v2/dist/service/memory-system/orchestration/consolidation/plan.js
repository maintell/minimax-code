import { createHash } from 'node:crypto';
import { renderStateMirror } from '../memory-files.js';
import { CONSOLIDATION_INPUT_CONTRACT } from './artifacts.js';
// 分词规则变化后重新整理既有摘要，避免沿用旧规则的完成标记。
const SUMMARY_TOKENIZER_CONTRACT = 'gpt-tokenizer@3.4.0/o200k_base:ordinary-text';
export function buildSelectionInputs(selection, maxTokens) {
    const docs = [];
    const selected = [];
    let inputTokens = 0;
    for (const state of selection) {
        if (!state.content)
            continue;
        const markdown = renderStateMirror(state);
        // 与 contractId 绑定的固定估算口径(§5.6)。
        const tokens = Math.ceil(Buffer.byteLength(markdown, 'utf8') / 4);
        if (inputTokens + tokens > maxTokens)
            break;
        inputTokens += tokens;
        selected.push(state);
        docs.push({ sessionId: state.sessionId, markdown, forgetRules: state.forgetRules });
    }
    return { docs, selected };
}
export function computeInputDigest(scopeKey, resetEpoch, selection, options) {
    const hash = createHash('sha256');
    const config = options?.config;
    hash.update(JSON.stringify([
        options?.contractId ?? 'empty',
        options?.governanceRevision ?? 0,
        SUMMARY_TOKENIZER_CONTRACT,
        CONSOLIDATION_INPUT_CONTRACT,
        config?.maxSelectedSessions,
        config?.maxConsolidationInputTokens,
        config?.maxMemoryMarkdownBytes,
        config?.maxSummaryInjectionTokens,
    ]));
    hash.update(scopeKey);
    hash.update(`\0${resetEpoch}\0`);
    for (const s of selection) {
        hash.update(JSON.stringify([s.sessionId, s.outputDigest, s.forgetRules ?? null]));
    }
    // 本轮之外的会话不进材料，内容变化不影响本轮；它们退出准入集合时 removed 会变，必须重新整理。
    // 准入集合全部进入本轮时不追加，已有完成标记保持有效。这里取准入集合减本轮选集，不按索引过滤，
    // 与 artifacts.ts 的 keptSources 口径不同：没有条目的会话退出准入集合不影响产物，但多算一次
    // 只会让整理多跑一轮。遗忘规则变化时 governanceRevision 已进入指纹。
    const selectedIds = new Set(selection.map((s) => s.sessionId));
    const outside = (options?.admitted ?? [])
        .map((s) => s.sessionId)
        .filter((id) => !selectedIds.has(id))
        .sort();
    if (outside.length > 0)
        hash.update(JSON.stringify(['admitted-outside-round', ...outside]));
    return hash.digest('base64url');
}
//# sourceMappingURL=plan.js.map