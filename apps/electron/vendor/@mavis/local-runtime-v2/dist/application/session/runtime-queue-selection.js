import { isComputerUseReadyForQueuedTurn, } from '../../service/computer-use/index.js';
import { isOrdinaryQuestionnaireResponseOrigin } from '@mavis/shared/questionnaire';
import { composeQueuedItemClassifier } from '../../service/plan/index.js';
import { settleInBackground } from '../../service/plugin-system/index.js';
import { isChannelQueueSource, } from '../../service/session-system/index.js';
import { hasPriorityUserQueueItem, isUserQueueInput, } from '../../service/turn-system/index.js';
/**
 * `QueueItem.source` is the wider `QueueMessageSource`, while the shared channel
 * predicate is typed to the narrower `LocalQueuedMessageSource` the IM wire
 * contract declares. The predicate only tests the `channel:` prefix, so narrowing
 * at this boundary is safe for every source a queued item can carry.
 */
function isChannelQueuedItem(item) {
    return isChannelQueueSource(item.source);
}
export function createRuntimeQueueSelection(input) {
    const countdown = createAsyncCountdownGate(input);
    return {
        classifyQueuedItem: composeQueuedItemClassifier({
            existing: async (item) => {
                // A queued ordinary-questionnaire reply is the message that resolves
                // the very questionnaire the admission gates are waiting on, so it
                // must bypass them: after a crash between its enqueue and the
                // injected marker, deferring it would deadlock the whole queue.
                if (isOrdinaryQuestionnaireResponseOrigin(item.message.origin))
                    return 'ready';
                // A legacy questionnaire holds every queued message until it is
                // resolved — except an IM-channel one. An IM user has no composer a
                // question card replaces: their message is a new instruction for the
                // agent, not an answer, and an IM ask_user always runs the legacy
                // protocol, so holding it strands the conversation with no way
                // forward. The questionnaire itself stays pending and stays
                // answerable from the card, the buttons, the numbered reply or
                // Desktop. An unanswered AskUser v2 question already stays answerable
                // while the conversation goes on; only an async one in its countdown
                // holds the user's earlier messages (the countdown gate below).
                const pendingQuestionnaire = isChannelQueuedItem(item)
                    ? undefined
                    : await input.questionnaires.getPending({
                        agentName: item.agentName,
                        sessionId: item.sessionId,
                        legacyOnly: true,
                    });
                if (pendingQuestionnaire && !(await input.legacyQuestionnaireHoldExempt?.(item.agentName)))
                    return 'defer';
                if (await countdown.holds(item))
                    return 'defer';
                // Goal queue selection reads the Plan fence itself so the wait reason it
                // projects names `plan`. The outer `lifecycleFence` below still runs and
                // stays the authority: it is the same fence, so a Goal item that reaches
                // it has already answered `false` and both agree. Nothing bypasses it —
                // in particular budget-limit continuations, which never consult the
                // dependency gates at all.
                const disposition = await input.goals.classifyQueuedItem(item, (sessionId) => input.lifecycleFence.blocks({ sessionId }));
                if (disposition !== 'ready')
                    return disposition;
                return (await isComputerUseReadyForQueuedTurn({
                    requested: item.message.computerUse?.enable === true,
                    client: input.computerUseClient,
                }))
                    ? 'ready'
                    : 'defer';
            },
            lifecycleFence: input.lifecycleFence,
            entryEnabled: input.entryEnabled,
        }),
        // GOAL-05 yield, applied at queue selection: a blocked item would
        // otherwise hold the FIFO head and stall every message queued behind it.
        //
        // Two sources yield. The autonomous Goal source yields whenever queued
        // user work waits behind it. A non-IM item additionally yields while a
        // pending legacy questionnaire is what defers it and an IM message is
        // queued behind it: an IM user cannot see the card that replaces the
        // composer, so their message must not wait behind a hold they can only
        // clear from a surface they are not on. The yielded item is released,
        // keeps its place and stays deferred — the questionnaire still holds it
        // until it is answered. An IM item never yields (the questionnaire never
        // defers it), and the item that takes the freed position still runs every
        // other gate: countdown, Goal, Plan fence and Computer Use.
        shouldYieldFifoPosition: async (item) => {
            if (item.source === 'thread-goal') {
                return hasPriorityUserQueueItem(await input.queue.list(item.sessionId));
            }
            if (isChannelQueuedItem(item))
                return false;
            // Cheapest check first: with no IM item queued nothing can be unblocked,
            // so the questionnaire is not read at all.
            const queued = await input.queue.list(item.sessionId);
            if (!queued.some((candidate) => isChannelQueuedItem(candidate)))
                return false;
            const pendingQuestionnaire = await input.questionnaires.getPending({
                agentName: item.agentName,
                sessionId: item.sessionId,
                legacyOnly: true,
            });
            if (!pendingQuestionnaire)
                return false;
            // An exempt Agent is never deferred by the questionnaire, so it has no
            // position to give up.
            return !(await input.legacyQuestionnaireHoldExempt?.(item.agentName));
        },
        close: countdown.close,
    };
}
/**
 * Whether a Turn that ended waiting for the user wakes its Session's queue. Normally it
 * does not: the user's earlier queued messages wait for the answer instead of running in
 * front of the question. Three cases do: the question's reply is already queued (the user
 * answered before the asking Turn released), an IM-channel message is queued (an IM user
 * has no composer a question card replaces, so their message is a new instruction that
 * must run; the questionnaire stays pending and answerable), and a coordinator's main
 * conversation, which goes on while its question waits. A failed read wakes nothing.
 */
export function createWaitingForUserQueueWake(input) {
    return async (sessionId) => {
        const queued = await input.queue.list(sessionId);
        if (queued.some((item) => isOrdinaryQuestionnaireResponseOrigin(item.message.origin)))
            return true;
        // An IM message queued while the question was being asked is a new
        // instruction, not an answer; without this wake it would sit queued until
        // the next inbound message arrives.
        if (queued.some((item) => isChannelQueuedItem(item)))
            return true;
        const session = await input.sessions.get(sessionId);
        return session !== undefined && (await input.isCoordinatorAgent(session.agentName));
    };
}
/**
 * AskUser v2 async countdown gate. An async ask_user returns at once and its
 * Turn runs on; Desktop then shows the card in place of the composer for
 * `countdownSeconds` (default 60). Without the gate, a message the user queued
 * before the question started the next Turn as soon as the asking Turn ended,
 * and an answer given inside the countdown could only be steered into that
 * Turn: the model acted on the older message before it read the answer.
 *
 * Held: user-typed items (isUserQueueInput, the rule the sync wait uses)
 * queued before an unanswered async questionnaire, until its countdown ends,
 * the user answers, or skips/closes it (the questionnaire side decides, see
 * `findAsyncCountdownHold`). Items queued after the question are the user's
 * newer instruction: they are never held, and once one is in the queue the
 * question holds nothing (the user chose to go on, as a queued message ends a
 * sync wait), so earlier and newer messages run in their FIFO order. Machine
 * items (Goal continuation, cron, background notices, communication) are
 * never held: Goal turns ask_user async, and holding its continuation would
 * stall every Goal question for the whole countdown.
 *
 * Wake: one unref'd timer per Session, kept at the earliest deadline that
 * held one of its items. When it fires the queue is dispatched and classified
 * again; an item still held (a later countdown) arms the next deadline, so a
 * countdown the user dismissed early never delays the wake. Timers are memory
 * only; after a restart the questionnaire startup recovery dispatches the
 * Sessions with an unanswered async questionnaire, which re-arms them.
 *
 * The deadline is the one Desktop counts down: both start from the
 * questionnaire's `createdAt`. Once the user works on the card Desktop keeps
 * it open past the deadline, but this gate still releases at the deadline.
 */
function createAsyncCountdownGate(input) {
    const wakes = new Map();
    // Per Session, the deadline each held item was last logged with: dispatch
    // re-classifies the head on every wake, so the defer is logged only once.
    const logged = new Map();
    let unavailableLogged = false;
    const findHold = async (item) => {
        const fields = { sessionId: item.sessionId, queueItemId: item.itemId };
        // Fail open: a broken or missing read must not freeze the queue; the
        // worst case is today's behaviour (the message runs right away).
        if (!input.questionnaires.findAsyncCountdownHold) {
            if (!unavailableLogged) {
                unavailableLogged = true;
                input.logger?.warn({ ...fields, reason: 'hold_read_unavailable' }, 'AskUser countdown queue gate unavailable; queued messages are not held');
            }
            return undefined;
        }
        try {
            const latestUserQueuedAt = latestUserQueueInputAt(await input.queue.list(item.sessionId));
            return await input.questionnaires.findAsyncCountdownHold({
                agentName: item.agentName,
                sessionId: item.sessionId,
                queuedAt: item.createdAt,
                ...(latestUserQueuedAt !== undefined ? { latestUserQueuedAt } : {}),
            });
        }
        catch (error) {
            input.logger?.warn({ ...fields, reason: 'hold_read_failed', err: error }, 'AskUser countdown hold read failed; the queued message is not held');
            return undefined;
        }
    };
    const wake = async (sessionId, deadlineAt) => {
        try {
            await input.dispatchQueue(sessionId);
        }
        catch (error) {
            input.logger?.warn({ sessionId, deadlineAt, reason: 'queue_wake_failed', err: error }, 'AskUser countdown queue wake failed');
        }
    };
    const wakeAt = (sessionId, deadlineAt) => {
        const current = wakes.get(sessionId);
        if (current && current.deadlineAt <= deadlineAt)
            return;
        if (current)
            clearTimeout(current.timer);
        const timer = setTimeout(() => {
            if (wakes.get(sessionId)?.timer !== timer)
                return;
            wakes.delete(sessionId);
            logged.delete(sessionId);
            input.logger?.info({ sessionId, deadlineAt }, 'AskUser countdown ended; waking the queue');
            settleInBackground(wake(sessionId, deadlineAt));
        }, Math.max(0, deadlineAt - input.nowMs()));
        timer.unref?.();
        wakes.set(sessionId, { deadlineAt, timer });
        input.logger?.info({ sessionId, deadlineAt }, 'AskUser countdown queue wake armed');
    };
    return {
        holds: async (item) => {
            if (!isUserQueueInput(item))
                return false;
            const hold = await findHold(item);
            if (!hold)
                return false;
            const sessionLogged = logged.get(item.sessionId) ?? new Map();
            logged.set(item.sessionId, sessionLogged);
            if (sessionLogged.get(item.itemId) !== hold.deadlineAt) {
                sessionLogged.set(item.itemId, hold.deadlineAt);
                input.logger?.info({
                    sessionId: item.sessionId,
                    queueItemId: item.itemId,
                    requestId: hold.requestId,
                    deadlineAt: hold.deadlineAt,
                    reason: 'async_countdown',
                }, 'Queued user message held until the AskUser countdown ends');
            }
            wakeAt(item.sessionId, hold.deadlineAt);
            return true;
        },
        close: () => {
            for (const { timer } of wakes.values())
                clearTimeout(timer);
            wakes.clear();
            logged.clear();
        },
    };
}
/** `createdAt` of the newest user-typed item in a Session queue (questionnaire answers excluded). */
function latestUserQueueInputAt(items) {
    let latest;
    for (const item of items) {
        if (isUserQueueInput(item) && (latest === undefined || item.createdAt > latest)) {
            latest = item.createdAt;
        }
    }
    return latest;
}
//# sourceMappingURL=runtime-queue-selection.js.map