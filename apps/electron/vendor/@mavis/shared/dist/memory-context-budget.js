import { MEMORY_CONTEXT_CAP_CHARS } from './memory-limits.js';
const TRUNCATION_NOTICE = '[Content truncated; read or search the original memory file for more.]';
/** 同一轮的记忆片段按调用顺序共享预算；完整块与片段均计入包装和分隔符。 */
export function createMemoryContextBudget(maxChars = MEMORY_CONTEXT_CAP_CHARS) {
    let remaining = Math.max(0, Math.min(MEMORY_CONTEXT_CAP_CHARS, maxChars));
    return {
        take(content, render, keep = 'tail', cap = MEMORY_CONTEXT_CAP_CHARS) {
            const bodyBudget = Math.min(cap, remaining - render('').length - 2);
            if (!content || bodyBudget <= 0)
                return undefined;
            let shown = content;
            if (shown.length > bodyBudget) {
                const textBudget = bodyBudget - TRUNCATION_NOTICE.length - 1;
                if (textBudget <= 0)
                    return undefined;
                shown =
                    keep === 'head'
                        ? `${content.slice(0, textBudget).replace(/[\uD800-\uDBFF]$/u, '')}\n${TRUNCATION_NOTICE}`
                        : `${TRUNCATION_NOTICE}\n${content.slice(-textBudget).replace(/^[\uDC00-\uDFFF]/u, '')}`;
            }
            remaining -= render(shown).length + 2;
            return shown;
        },
        include(block) {
            if (!block || block.length + 2 > remaining)
                return false;
            remaining -= block.length + 2;
            return true;
        },
    };
}
/** Prompt range 已由组装器标注，宿主据此为动态记忆扣除本轮静态占用。 */
export function memoryContextCharsUsed(ranges) {
    if (!Array.isArray(ranges))
        return 0;
    return ranges.reduce((total, range) => {
        if (!range || typeof range !== 'object')
            return total;
        const { kind, startOffset, endOffset } = range;
        if (kind !== 'MEMORY' || typeof startOffset !== 'number' || typeof endOffset !== 'number') {
            return total;
        }
        return total + Math.max(0, endOffset - startOffset) + 2;
    }, 0);
}
//# sourceMappingURL=memory-context-budget.js.map