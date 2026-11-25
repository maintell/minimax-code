import { carriesInWindow, prepareWindowFrozenReminder, } from './window-frozen-reminder.js';
/** @internal Exported only for focused tests. */
export const MEMORY_SUMMARY_REMINDER_CUSTOM_TYPE = 'memory_v2_summary';
/**
 * Places the Memory summary as one hidden message near the start of the
 * model-visible context, the way Codex and ZCode carry theirs.
 *
 * Memory owns the text; this module only decides where it sits. The summary is
 * background reference, so it is frozen for one context window: the copy in
 * context stays byte-identical even after consolidation, forget or manual edits
 * change the file, and the prompt cache keeps hitting. The current
 * summary only replaces it once compaction has summarized the old copy away,
 * when the prefix is rebuilt anyway. Mid-window, the model reads current memory
 * through memories_search / memories_read.
 *
 * Only a loss of recall access (recall off, Memory V2 not assembled, a Reset
 * after the Session was created) withdraws the copies from the provider
 * request; durable history stays untouched.
 */
export function createMemorySummaryReminder(loadSummaryContext, usageAnchor) {
    return {
        async prepare({ hookInput }) {
            const summary = await loadSummaryContext(hookInput.sessionId);
            return prepareWindowFrozenReminder({
                customType: MEMORY_SUMMARY_REMINDER_CUSTOM_TYPE,
                content: memorySummaryContent(summary),
                hookInput,
                usageAnchor,
            });
        },
    };
}
function memorySummaryContent(summary) {
    if (summary.status === 'disabled')
        return { status: 'withdrawn' };
    if (summary.status !== 'ready')
        return { status: 'none' };
    return { status: 'ready', content: summary.content };
}
/**
 * Whether a summary copy, whatever its text, is in context after the latest
 * compaction (or anywhere when never compacted).
 * @internal Exported only for focused tests.
 */
export function carriesSummaryInWindow(messages) {
    return carriesInWindow(MEMORY_SUMMARY_REMINDER_CUSTOM_TYPE, messages);
}
//# sourceMappingURL=memory-summary-reminder.js.map