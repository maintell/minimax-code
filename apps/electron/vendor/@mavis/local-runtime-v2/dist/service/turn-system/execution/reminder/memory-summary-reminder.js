import { fitsReminderInFinalRequest } from './reminder-admission.js';
/** @internal Exported only for focused tests. */
export const MEMORY_SUMMARY_REMINDER_CUSTOM_TYPE = 'memory_v2_summary';
/**
 * Places the Memory summary as one hidden message near the start of the
 * model-visible context, the way Codex and ZCode carry theirs.
 *
 * Memory owns the text; this module only decides where it sits. The message is
 * durable, so while the summary stays the same it is byte-identical at the same
 * position and the prompt cache keeps hitting; the system prompt keeps only the
 * stable rules.
 *
 * Each Turn reads the current summary once. A copy in context counts only when
 * its text equals the current summary: Reset, forget, manual edits and new
 * consolidations all change that text, so stale copies are withdrawn from the
 * provider request (durable history stays untouched) and the current summary
 * goes before the current user message. Compaction that summarizes it away gets
 * it put back. Without a summary (recall off, Memory V2 not assembled, nothing
 * generated) every copy is withdrawn.
 */
export function createMemorySummaryReminder(loadSummaryContext, usageAnchor) {
    return {
        async prepare({ hookInput }) {
            const content = await loadSummaryContext(hookInput.sessionId);
            const withdraw = createStaleSummaryWithdrawHook(content);
            if (!content)
                return { beforeUserMessages: [], hooks: [withdraw] };
            const marker = carriesCurrentSummary(hookInput.canonicalMessages, content)
                ? undefined
                : createMemorySummaryMarker(content);
            const fits = marker !== undefined && fitsReminderInFinalRequest(hookInput, marker, usageAnchor);
            return {
                beforeUserMessages: marker && fits ? [marker] : [],
                hooks: [withdraw, createMemorySummaryRestoreHook(content, usageAnchor)],
            };
        },
    };
}
/** Request-only: copies that no longer match the current summary must not reach the model. */
function createStaleSummaryWithdrawHook(content) {
    const isStale = (message) => isMemorySummaryMessage(message) && message.content !== content;
    return (input) => {
        if (!input.messages.some(isStale))
            return undefined;
        return {
            type: 'replaceRequestMessages',
            reason: `${MEMORY_SUMMARY_REMINDER_CUSTOM_TYPE}_withdrawn`,
            messages: input.messages.filter((message) => !isStale(message)),
        };
    };
}
function createMemorySummaryRestoreHook(content, usageAnchor) {
    return (input) => {
        if (carriesCurrentSummary(input.canonicalMessages, content))
            return undefined;
        const marker = createMemorySummaryMarker(content);
        if (!fitsReminderInFinalRequest(input, marker, usageAnchor))
            return undefined;
        return {
            type: 'appendMessage',
            reason: MEMORY_SUMMARY_REMINDER_CUSTOM_TYPE,
            message: marker,
            // Only takes effect after an initial compaction; otherwise the prepared
            // before-user message already covers the first request.
            ...(input.phase === 'initial' ? { placement: 'before-current-user' } : {}),
        };
    };
}
function createMemorySummaryMarker(content) {
    return {
        role: 'custom',
        customType: MEMORY_SUMMARY_REMINDER_CUSTOM_TYPE,
        content,
        display: false,
        timestamp: Date.now(),
    };
}
/**
 * Whether the current summary is in context after the latest compaction (or
 * anywhere when never compacted).
 * @internal Exported only for focused tests.
 */
export function carriesCurrentSummary(messages, content) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!isRecord(message))
            continue;
        // Native summaries and legacy (archon) compaction markers both start a
        // fresh model-visible context; anything before them was summarized away.
        if (message.role === 'compactionSummary' || Object.hasOwn(message, 'archonCompaction')) {
            return false;
        }
        if (isMemorySummaryMessage(message) && message.content === content)
            return true;
    }
    return false;
}
function isMemorySummaryMessage(message) {
    return (isRecord(message) &&
        message.role === 'custom' &&
        message.customType === MEMORY_SUMMARY_REMINDER_CUSTOM_TYPE);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
//# sourceMappingURL=memory-summary-reminder.js.map