import { BUNNY_AGENT_NAME } from '../bunny/index.js';
import { appendMcodeStateLines, wrapSystemReminder } from '../coordinator-text/index.js';
import { isUserMessageId } from '../session-system/shared/user-message-id.js';
import { isStateDeltaMessage, } from '../turn-system/index.js';
import { OptionalReads, settleOwed, unreadableLine, } from './state/unreadable-items.js';
import { TASK_KEY, UNDELIVERED as UNDELIVERED_TASK } from './state/task-delta.js';
/**
 * Delivers Bunny's state through delta blocks in history (spec 8.6, 9). The
 * port renders the block for Bunny's main conversation only. The history
 * observer advances the delivery baseline once the block and the user message
 * after it are committed, and clears it when a segment rebuild commits. A Turn
 * aborted before its input reached history leaves the baseline as it was.
 */
export function createAssignmentStateDelivery(options) {
    const pending = new Map();
    const traces = new Map();
    const clear = (sessionId) => {
        pending.delete(sessionId);
        options.baseline.clear(sessionId);
    };
    const skipped = (skip) => {
        try {
            options.optionalSkipped?.(skip);
        }
        catch (error) {
            options.onError?.(error);
        }
    };
    const port = {
        prefixes: options.prefixes,
        prepare: async (input) => {
            if (input.agentName !== BUNNY_AGENT_NAME)
                return undefined;
            if (!(await options.isMainConversation(input.sessionId)))
                return undefined;
            const skip = options.skipUnreadable?.() === true;
            const preparedAtMs = options.nowMs();
            const rendered = await options.snapshots.render({
                sessionId: input.sessionId,
                turnId: input.turnId,
                wakeReasons: input.wakeReasons,
                origin: input.origin,
                userText: input.userText,
                frontContextMessageIds: input.frontContextMessageIds,
                ...(input.currentMessageIds ? { currentMessageIds: input.currentMessageIds } : {}),
                ...(skip ? { skipUnreadable: true } : {}),
            });
            const reads = new OptionalReads(skip);
            const reminders = await readReminders(options, input, rendered, reads);
            pending.set(input.sessionId, {
                turnId: input.turnId,
                updates: new Map([...rendered.updates, ...reminders.updates]),
                full: rendered.mode === 'full',
                preparedAtMs,
                report: input.wakeReasons.includes('task_report'),
                deltaWritten: false,
            });
            traces.set(input.sessionId, { input, rendered, firstMeeting: isFirstUserTurn(input) });
            for (const left of [...(rendered.skipped ?? []), ...reads.skipped()])
                skipped({ sessionId: input.sessionId, turnId: input.turnId, ...left });
            const block = (lines) => [
                appendMcodeStateLines(rendered.content, [...reads.lines('reminders'), ...lines]),
                ...reminders.texts.map((text) => wrapSystemReminder(text)),
            ].join('\n\n');
            // Whether the frozen prompt leaves memory out is known once the prefix is applied.
            const memoryUnreadable = skip && options.memoryUnreadable?.(input.sessionId) === true;
            return {
                content: block([]),
                ...(memoryUnreadable ? { withoutMemory: block([unreadableLine('memory')]) } : {}),
            };
        },
        prefixApplied: (facts) => {
            if (facts.memoryLeftOut)
                skipped({ sessionId: facts.sessionId, turnId: facts.turnId, item: 'memory', count: 1 });
            const trace = traces.get(facts.sessionId);
            traces.delete(facts.sessionId);
            if (!trace || trace.input.turnId !== facts.turnId)
                return;
            options.trace?.injected({
                sessionId: facts.sessionId,
                turnId: facts.turnId,
                wakeReasons: trace.input.wakeReasons,
                ...(trace.firstMeeting ? { firstMeeting: true } : {}),
                rendered: trace.rendered,
                prefix: facts,
            });
        },
        ...(options.recallPointers
            ? { steeredRecallPointers: steeredRecallPointers(options.recallPointers, options.trace) }
            : {}),
    };
    return {
        port,
        /** Clears a conversation's baseline: a segment rebuild or a rewind (spec 9.4). */
        clear,
        /** A segment rebuild committed: full state and a fresh prefix next Turn (spec 8.3, 9.4). */
        segmentRebuilt: (sessionId) => {
            clear(sessionId);
            options.prefixes.segmentRebuilt(sessionId);
        },
        observer: {
            observeHistoryCommitted: (input) => {
                const { sessionId, turnId } = input.context;
                if (isSegmentRebuild(input.change)) {
                    // Any Session may compact; only a Bunny main conversation has a baseline to clear.
                    clear(sessionId);
                    options.prefixes.segmentRebuilt(sessionId);
                    return;
                }
                options.trace?.committed(sessionId, turnId, input.change.messages);
                const delivery = pending.get(sessionId);
                if (!delivery || delivery.turnId !== turnId || input.change.reason !== 'messageDelta')
                    return;
                if (!advancesOn(delivery, input.change.messages))
                    return;
                pending.delete(sessionId);
                try {
                    options.baseline.advance(sessionId, {
                        updates: delivery.updates,
                        full: delivery.full,
                        preparedAtMs: delivery.preparedAtMs,
                        nowMs: options.nowMs(),
                    });
                    options.trace?.delivered(sessionId, turnId, deliveredTasks(delivery.updates));
                    if (delivery.report)
                        options.firstUse?.reported();
                }
                catch (error) {
                    options.onError?.(error);
                }
            },
        },
    };
}
/** Tasks a delta block delivered: their baseline now holds a state, not the "pending" mark. */
function deliveredTasks(updates) {
    const sessions = [];
    for (const [key, state] of updates)
        if (key.startsWith(TASK_KEY) && state !== null && state !== UNDELIVERED_TASK)
            sessions.push(key.slice(TASK_KEY.length));
    return sessions;
}
/**
 * The user wakes this Turn, and no earlier user message is in the conversation:
 * the user is writing to Bunny for the first time. A compaction may rewrite every
 * earlier user message under new IDs, so a compacted conversation never counts.
 */
function isFirstUserTurn(input) {
    if (input.compacted || !input.wakeReasons.includes('user'))
        return false;
    const current = new Set(input.currentMessageIds ?? []);
    return !input.frontContextMessageIds.some((id) => !current.has(id) && isUserMessageId(id));
}
/**
 * The reminders that follow the delta block: the first-meeting reminder on the
 * user's first Turn, the first-use reminders after a full block. Either one
 * that a Turn could not read while unreadable parts are skipped is owed, and
 * comes on the next Turn it is due again (emergency rebuild spec 7.2).
 */
async function readReminders(options, input, rendered, reads) {
    const owed = rendered.owed ?? new Set();
    const language = firstMeetingLanguage(input.userText);
    const meetingDue = isFirstUserTurn(input) || (owed.has('first_meeting') && input.wakeReasons.includes('user'));
    // Only a full block: it opens the conversation and follows every compaction.
    const firstUseDue = rendered.mode === 'full' || owed.has('first_use');
    const meeting = meetingDue
        ? await readReminder(options, reads, () => options.firstMeeting?.(language))
        : undefined;
    const firstUse = firstUseDue
        ? await readReminder(options, reads, () => options.firstUse?.pending(language))
        : undefined;
    const updates = new Map();
    settleOwed(updates, 'first_meeting', {
        due: meetingDue,
        delivered: meeting?.ok === true,
        owed: owed.has('first_meeting'),
        skip: reads.skip,
    });
    settleOwed(updates, 'first_use', {
        due: firstUseDue,
        delivered: firstUse?.ok === true,
        owed: owed.has('first_use'),
        skip: reads.skip,
    });
    return {
        texts: [meeting, firstUse].flatMap((read) => (read?.ok && read.value ? [read.value] : [])),
        updates,
    };
}
/** A reminder is guidance, not state: a failed read leaves the Turn without it. */
async function readReminder(options, reads, read) {
    try {
        return { ok: true, value: (await read())?.trim() || undefined };
    }
    catch (error) {
        options.onError?.(error);
        reads.leave('reminders');
        return { ok: false };
    }
}
/**
 * English when the message has Latin letters and no CJK characters; Chinese otherwise.
 * @internal Exported only for focused tests.
 */
export function firstMeetingLanguage(text) {
    if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(text))
        return 'zh';
    return /[A-Za-z]/.test(text) ? 'en' : 'zh';
}
/** Every committed compaction replaces the history, so it starts a segment (spec 2.2). */
function isSegmentRebuild(change) {
    return change.operation?.kind === 'compaction';
}
/** True once the delta block and then a user message are both in history. */
function advancesOn(delivery, messages) {
    for (const message of messages) {
        if (isStateDeltaMessage(message)) {
            delivery.deltaWritten = true;
            continue;
        }
        if (delivery.deltaWritten &&
            typeof message === 'object' &&
            message !== null &&
            Reflect.get(message, 'role') === 'user')
            return true;
    }
    return false;
}
/**
 * A user message steered into a busy Turn gets its own recall precheck
 * (spec 15.7); its trace is recorded like the Turn-start one (17.1).
 */
function steeredRecallPointers(recall, trace) {
    return ({ turnId, ...request }) => {
        const result = recall(request);
        if (result.trace !== undefined)
            trace?.steeredPrecheck({ sessionId: request.sessionId, turnId, precheck: result.trace });
        return result.text;
    };
}
//# sourceMappingURL=snapshot-reminder.js.map