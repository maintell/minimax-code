import { fitsReminderInFinalRequest } from './reminder-admission.js';
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
            if (summary.status === 'disabled') {
                return { beforeUserMessages: [], hooks: [createWithdrawAllHook()] };
            }
            const keepOne = createKeepWindowCopyHook();
            if (summary.status !== 'ready')
                return { beforeUserMessages: [], hooks: [keepOne] };
            const marker = carriesSummaryInWindow(hookInput.canonicalMessages)
                ? undefined
                : createMemorySummaryMarker(summary.content);
            const fits = marker !== undefined && fitsReminderInFinalRequest(hookInput, marker, usageAnchor);
            return {
                beforeUserMessages: marker && fits ? [marker] : [],
                hooks: [keepOne, createMemorySummaryRestoreHook(summary.content, usageAnchor)],
            };
        },
    };
}
/** Request-only: without recall access no copy may reach the model. */
function createWithdrawAllHook() {
    return (input) => {
        if (!input.messages.some(isMemorySummaryMessage))
            return undefined;
        return {
            type: 'replaceRequestMessages',
            reason: `${MEMORY_SUMMARY_REMINDER_CUSTOM_TYPE}_withdrawn`,
            messages: input.messages.filter((message) => !isMemorySummaryMessage(message)),
        };
    };
}
/**
 * Request-only: sends exactly the frozen copy of the current window. Earlier
 * Runtimes appended a fresh copy whenever the summary changed; keeping the
 * latest one matches what they sent, so upgrading does not move the prefix.
 */
function createKeepWindowCopyHook() {
    return (input) => {
        const keep = latestSummaryIndexInWindow(input.messages);
        const extra = (message, index) => isMemorySummaryMessage(message) && index !== keep;
        if (!input.messages.some(extra))
            return undefined;
        return {
            type: 'replaceRequestMessages',
            reason: `${MEMORY_SUMMARY_REMINDER_CUSTOM_TYPE}_deduplicated`,
            messages: input.messages.filter((message, index) => !extra(message, index)),
        };
    };
}
function createMemorySummaryRestoreHook(content, usageAnchor) {
    return (input) => {
        if (carriesSummaryInWindow(input.canonicalMessages))
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
 * Whether a summary copy, whatever its text, is in context after the latest
 * compaction (or anywhere when never compacted).
 * @internal Exported only for focused tests.
 */
export function carriesSummaryInWindow(messages) {
    return latestSummaryIndexInWindow(messages) !== -1;
}
function latestSummaryIndexInWindow(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!isRecord(message))
            continue;
        // Native summaries and legacy (archon) compaction markers both start a
        // fresh model-visible context; anything before them was summarized away.
        if (message.role === 'compactionSummary' || Object.hasOwn(message, 'archonCompaction')) {
            return -1;
        }
        if (isMemorySummaryMessage(message))
            return index;
    }
    return -1;
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