/** @internal Exported for focused tests. */
export const PTC_REMINDER_RESTORE_REASON = 'ptc-reminder-after-compaction';
const PTC_REMINDER_RESTORED_LOG = 'ptc reminder restored after compaction';
/** Compaction seen but nothing inserted; `reason` says why (already_present, does_not_fit). */
const PTC_REMINDER_SKIPPED_LOG = 'ptc reminder restore skipped after compaction';
/**
 * Brackets the other request-only after-compaction hooks with the restorer:
 * its iteration hook first, its initial hook last (see
 * PtcCompactionReminderHooks for why the initial request differs).
 */
export function withPtcCompactionReminder(ptcReminder, hooks) {
    return ptcReminder ? [ptcReminder.iteration, ...hooks, ptcReminder.initial] : hooks;
}
/**
 * Puts the catalog's PTC reminder back into the provider request after
 * compaction replaced the user message that carried it.
 *
 * The reminder rides at the start of the Turn's user message. Automatic
 * compaction inside the Turn replaces that message, with the rest of the
 * history, by one compactionSummary; the system prompt is not compacted, so
 * its PTC section survives but the hidden-tool list in the reminder does not.
 * In the eval the model then called a hidden tool directly.
 *
 * Request-only (replaceRequestMessages), like the execution budget reminder:
 * the pipeline runs again for every request, starting from durable history
 * that never contains the restored copy, so the request has exactly one copy
 * however many times the Turn compacts, durable history and its format stay
 * untouched, and the next Turn starts from its own user-message prefix. The
 * copy is the same text the prefix carries, as a user message, and sits right
 * after the latest summary instead of at the end so the request prefix stays
 * the same between compactions (prompt cache). Requests that still carry the
 * reminder in a user message (before compaction, tool-result-only compaction,
 * or a later Turn after an earlier summary) are left unchanged.
 */
export function createPtcCompactionReminderRestorer(reminder, canAppend, logger) {
    if (!reminder)
        return undefined;
    // One line per compaction summary and outcome; the hook itself runs on
    // every request after a compaction.
    const logged = new Set();
    const logOnce = (input, summary, message, reason) => {
        const key = `${reason}:${summaryKey(summary)}`;
        if (logged.has(key))
            return;
        logged.add(key);
        try {
            logger?.info?.({ session_id: input.sessionId, turn_id: input.turnId, phase: input.phase, reason }, message);
        }
        catch {
            // A failing logger cannot report itself; the request must not depend on it.
        }
    };
    const restore = (input) => {
        try {
            const summaryIndex = findLastCompactionSummary(input.messages);
            const summary = input.messages[summaryIndex];
            // No summary in this request: the reminder is still in the user message.
            if (summary === undefined)
                return undefined;
            if (input.messages.some((message) => carriesReminder(message, reminder))) {
                logOnce(input, summary, PTC_REMINDER_SKIPPED_LOG, 'already_present');
                return undefined;
            }
            const marker = {
                role: 'user',
                content: reminder,
                // The summary's own time keeps the copy identical on every request.
                timestamp: summaryTimestamp(summary),
            };
            if (canAppend && !canAppend(input, marker)) {
                logOnce(input, summary, PTC_REMINDER_SKIPPED_LOG, 'does_not_fit');
                return undefined;
            }
            logOnce(input, summary, PTC_REMINDER_RESTORED_LOG, 'compaction_summary_without_reminder');
            return {
                type: 'replaceRequestMessages',
                reason: PTC_REMINDER_RESTORE_REASON,
                messages: [
                    ...input.messages.slice(0, summaryIndex + 1),
                    marker,
                    ...input.messages.slice(summaryIndex + 1),
                ],
            };
        }
        catch (error) {
            // Fail open to today's behaviour (no reminder after compaction), but say so.
            try {
                logger?.warn?.({
                    session_id: input.sessionId,
                    turn_id: input.turnId,
                    phase: input.phase,
                    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
                }, 'ptc reminder restore failed');
            }
            catch {
                // A failing logger cannot report itself; the request must not depend on it.
            }
            return undefined;
        }
    };
    const inPhase = (phase) => (input) => input.phase === phase ? restore(input) : undefined;
    return { iteration: inPhase('iteration'), initial: inPhase('initial') };
}
function findLastCompactionSummary(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message && Reflect.get(message, 'role') === 'compactionSummary')
            return index;
    }
    return -1;
}
/** Only real user messages count; a summary quoting the reminder is not the reminder. */
function carriesReminder(message, reminder) {
    if (message.role !== 'user')
        return false;
    const content = message.content;
    if (typeof content === 'string')
        return content.includes(reminder);
    if (!Array.isArray(content))
        return false;
    return content.some((block) => typeof block === 'object' &&
        block !== null &&
        Reflect.get(block, 'type') === 'text' &&
        typeof Reflect.get(block, 'text') === 'string' &&
        Reflect.get(block, 'text').includes(reminder));
}
function summaryTimestamp(summary) {
    const timestamp = Reflect.get(summary, 'timestamp');
    return typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : 0;
}
function summaryKey(summary) {
    return `${summaryTimestamp(summary)}:${String(Reflect.get(summary, 'tokensBefore'))}`;
}
//# sourceMappingURL=compaction-reminder.js.map