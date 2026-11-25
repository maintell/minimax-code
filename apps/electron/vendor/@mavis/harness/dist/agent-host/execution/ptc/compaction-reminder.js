import { compactionSummaryKey, compactionSummaryTimestamp, findLastCompactionSummary, projectToolSearchContext, } from '../../tools/tool-search.js';
/** @internal Exported for focused tests. */
export const PTC_REMINDER_RESTORE_REASON = 'ptc-reminder-after-compaction';
const PTC_REMINDER_RESTORED_LOG = 'ptc reminder restored after compaction';
/** Compaction seen but nothing inserted; `reason` says why (already_present, does_not_fit). */
const PTC_REMINDER_SKIPPED_LOG = 'ptc reminder restore skipped after compaction';
/**
 * The reminder restore of each Session's latest Turn, repeated by the
 * shared-prefix checkpoint request (`projectTurnRequestContext`) and dropped
 * with the Session (`disposePtcCompactionReminderSession`). Process-local like
 * the Tool Search request context: a restarted process repeats nothing until
 * the next Turn.
 */
const MAX_SESSIONS = 512;
const sessionContexts = new Map();
/**
 * Brackets the other request-only after-compaction hooks with the restorer:
 * its iteration hook first, its initial hook last (see
 * PtcCompactionReminderHooks for why the initial request differs).
 */
export function withPtcCompactionReminder(ptcReminder, hooks) {
    return ptcReminder ? [ptcReminder.iteration, ...hooks, ptcReminder.initial] : hooks;
}
/**
 * The request-only context the Session's latest Turn inserts right after the
 * latest compaction summary, in the main request's order: the Tool Search
 * context, then the PTC reminder copy (both restorer hooks run before the Tool
 * Search hook of the same phase, see `withPtcCompactionReminder` and
 * `ToolSearchContextHooks`). The shared-prefix checkpoint request repeats it
 * as the `turnContext` of `createMainRequestProjection`.
 */
export function projectTurnRequestContext(sessionId, messages) {
    return projectToolSearchContext(sessionId, projectPtcCompactionReminder(sessionId, messages));
}
/**
 * The PTC reminder copy the Session's latest Turn puts into its main requests,
 * applied to `messages`: within the generation of the Session's latest main
 * request, of this Turn or an earlier one, exactly what that request inserted;
 * otherwise what the Turn would insert.
 */
function projectPtcCompactionReminder(sessionId, messages) {
    const context = sessionContexts.get(sessionId);
    if (!context)
        return messages;
    try {
        const summaryIndex = findLastCompactionSummary(messages);
        const summary = messages[summaryIndex];
        const generation = generationOf(summary);
        let marker;
        if (context.sent?.generation === generation)
            marker = context.sent.marker;
        else if (summary && !messages.some((message) => carriesReminder(message, context.reminder))) {
            // The same block the main request of this generation uses, so the
            // checkpoint's prefix and the main request's prefix stay identical.
            marker = reminderMarker(context.reminder, summary, storedForGeneration(context.stored, generation, context.storedValues));
        }
        if (!marker)
            return messages;
        return [...messages.slice(0, summaryIndex + 1), marker, ...messages.slice(summaryIndex + 1)];
    }
    catch {
        // The checkpoint falls back to the history as is, like a failed hook.
        return messages;
    }
}
/** Drops the reminder restore kept for a disposed Session. */
export function disposePtcCompactionReminderSession(sessionId) {
    sessionContexts.delete(sessionId);
}
export function createPtcCompactionReminderRestorer(sessionId, reminder, canAppend, options) {
    const { logger, storedValues } = options ?? {};
    const previous = sessionContexts.get(sessionId);
    sessionContexts.delete(sessionId);
    if (!reminder)
        return undefined;
    // Carried over from the previous Turn: a generation that already read its
    // block keeps it, so a later Turn of the same generation sends the same
    // prefix.
    const stored = previous?.stored ?? {
        generation: undefined,
        block: undefined,
    };
    const context = {
        reminder,
        storedValues,
        stored,
        sent: previous?.sent,
    };
    sessionContexts.set(sessionId, context);
    if (sessionContexts.size > MAX_SESSIONS) {
        const oldest = sessionContexts.keys().next().value;
        if (oldest !== undefined)
            sessionContexts.delete(oldest);
    }
    // One line per compaction summary and outcome; the hook itself runs on
    // every request after a compaction.
    const logged = new Set();
    const logOnce = (input, summary, message, reason) => {
        const key = `${reason}:${compactionSummaryKey(summary)}`;
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
        const before = context.sent;
        // What this request inserts; nothing unless the restore below says otherwise.
        context.sent = undefined;
        try {
            const summaryIndex = findLastCompactionSummary(input.messages);
            const summary = input.messages[summaryIndex];
            const latch = generationLatch(before, summary, input);
            context.sent = { ...latch, marker: undefined };
            // No summary in this request: the reminder is still in the user message.
            if (summary === undefined)
                return undefined;
            if (input.messages.some((message) => carriesReminder(message, reminder))) {
                logOnce(input, summary, PTC_REMINDER_SKIPPED_LOG, 'already_present');
                return undefined;
            }
            if (latch.dropped === reminder)
                return undefined;
            const marker = reminderMarker(reminder, summary, storedForGeneration(context.stored, latch.generation, storedValues));
            if (canAppend && !canAppend(input, marker)) {
                context.sent = { ...latch, marker: undefined, dropped: reminder };
                logOnce(input, summary, PTC_REMINDER_SKIPPED_LOG, 'does_not_fit');
                return undefined;
            }
            logOnce(input, summary, PTC_REMINDER_RESTORED_LOG, 'compaction_summary_without_reminder');
            context.sent = { ...latch, marker };
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
    return {
        iteration: (input) => {
            if (input.phase === 'iteration')
                return restore(input);
            // First in the pipeline on the Turn's first request too, while `initial`
            // may never run there: the request carries no copy unless it does.
            const before = context.sent;
            context.sent = undefined;
            try {
                const summary = input.messages[findLastCompactionSummary(input.messages)];
                context.sent = { ...generationLatch(before, summary, input), marker: undefined };
            }
            catch {
                // Bookkeeping must not affect the request.
            }
            return undefined;
        },
        initial: (input) => (input.phase === 'initial' ? restore(input) : undefined),
    };
}
/**
 * The request's generation (its latest summary, or the start) and capacity,
 * and the reminder that stays out: one dropped earlier in the same generation
 * under the same capacity. Capacity is what `canAppend` measures against: the
 * model (its context window and output reserve set the provider input limit)
 * and the serialized cap.
 */
function generationLatch(before, summary, input) {
    const generation = generationOf(summary);
    const capacity = JSON.stringify([
        input.model.provider,
        input.model.id,
        input.model.contextWindow,
        input.maxTokens ?? input.model.maxTokens,
        input.maxSerializedInputBytes ?? null,
    ]);
    const dropped = before?.generation === generation && before.capacity === capacity ? before.dropped : undefined;
    return { generation, capacity, dropped };
}
/**
 * The generation's stored-values block, reading it the first time this
 * generation asks. Undefined is a real answer the generation keeps, so an
 * emptied store never falls back to an older generation's list.
 */
function storedForGeneration(cache, generation, read) {
    if (cache.generation !== generation) {
        cache.generation = generation;
        cache.block = read?.();
    }
    return cache.block;
}
/** The compaction generation a request belongs to: its latest summary, or the start. */
function generationOf(summary) {
    return summary ? compactionSummaryKey(summary) : 'start';
}
/**
 * The reminder copy after `summary`; the summary's own time keeps it identical on every request.
 * `stored` is the Session's stored-values block, appended only when the Turn has one.
 */
function reminderMarker(reminder, summary, stored) {
    return {
        role: 'user',
        content: stored === undefined ? reminder : `${reminder}\n\n${stored}`,
        timestamp: compactionSummaryTimestamp(summary),
    };
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
//# sourceMappingURL=compaction-reminder.js.map