import { ConversationTurnRejectedError } from '@mavis/conversation-contract';
import { verdictIdempotencyKey, } from '../../session-system/index.js';
import { renderVerdictNotice } from './verdict-notice.js';
/**
 * The origin a wake Turn carries: only the chat to answer in, and only when there is
 * one. A desktop task's wake stays exactly as before, with no origin at all. The key
 * is not `assignmentReport`: a wake is not a task report, and its wake reason stays.
 */
function verdictWakeOrigin(channel) {
    return channel ? { verdictWake: { channel: { ...channel } } } : undefined;
}
/** The chat a checked task answers in, as the field of its wake. */
function wakeChannel(assignment) {
    return assignment.originChannel ? { originChannel: assignment.originChannel } : {};
}
function channelKey(wake) {
    const channel = wake.originChannel;
    return channel
        ? JSON.stringify([channel.platform, channel.clientName, channel.chatId, channel.threadId ?? ''])
        : '';
}
/** How long a stored verdict waits before it wakes its assigner. */
const VERDICT_WAKE_DELAY_MS = 2000;
/** Task history type marking one verdict as already woken. */
const VERDICT_DELIVERED = 'task.verdict_delivered';
/**
 * Verdict wakes: a stored verdict reaches its assigner as a Turn of its own, so Bunny
 * reads the verdict, tells the user, and only then concludes the task.
 *
 * Separate from report batches: a verdict wake is not a task report and never carries a
 * report origin; a task from an IM chat carries only `verdictWake.channel`. A verdict already marked delivered in task history is never woken
 * again, so a retry after a crash cannot produce a second Turn.
 */
export class VerdictWakeDelivery {
    deps;
    batches = new Map();
    timers = new Map();
    delivering = new Set();
    constructor(deps) {
        this.deps = deps;
    }
    /**
     * A review verdict was stored: wake the checked task's assigner in a Turn of its own.
     *
     * Call this only for a verdict the store actually applied. Redelivery safety does not
     * rely on that: a verdict already marked delivered in task history is never woken
     * again, so a retry after a crash cannot produce a second Turn.
     */
    recorded(sessionId, verdict) {
        // A switched-off gate wakes nobody: there is no conclusion for the assigner to read and
        // act on, and the sweep releases whatever link is left instead.
        if (this.deps.options.verdictGate?.() !== true)
            return;
        this.deps.track(async () => {
            const assignment = await this.deps.options.tasks.get(sessionId);
            if (!assignment)
                return;
            const target = await this.deps.reportTarget(assignment);
            if (!target)
                return;
            const wake = {
                sessionId,
                verdict,
                key: verdictIdempotencyKey({
                    reviewTaskId: verdict.reviewTaskId,
                    revision: verdict.revision,
                }),
                ...wakeChannel(assignment),
            };
            const batch = this.batches.get(target) ?? new Map();
            batch.set(sessionId, wake);
            this.batches.set(target, batch);
            this.deps.onDelivered?.(sessionId);
            this.schedule(target);
        });
    }
    /**
     * Startup recovery: a verdict stored before the last shutdown is woken again.
     *
     * The batches live in this process, so a restart loses every wake that had not gone out
     * yet, and nothing else would pick them up: the backstop only retries what is already
     * held here. Re-reading the task graph puts each stored verdict of an open task back into
     * its assigner's batch. A verdict task history already records as delivered is dropped
     * again by collectPending, so this never produces a second Turn.
     */
    async recover() {
        if (this.deps.isClosed() || this.deps.options.verdictGate?.() !== true)
            return;
        for (const { sessionId, assignment } of await this.deps.options.tasks.list({
            archived: false,
        })) {
            const verdict = assignment.verdict;
            if (!verdict || assignment.completion)
                continue;
            const target = await this.deps.reportTarget(assignment);
            if (!target)
                continue;
            const batch = this.batches.get(target) ?? new Map();
            batch.set(sessionId, {
                sessionId,
                verdict,
                key: verdictIdempotencyKey({
                    reviewTaskId: verdict.reviewTaskId,
                    revision: verdict.revision,
                }),
                ...wakeChannel(assignment),
            });
            this.batches.set(target, batch);
        }
        for (const [target, batch] of this.batches)
            if (batch.size)
                this.schedule(target);
    }
    /** A Turn of `target` settled; a wake held for it may go out now. */
    settled(target) {
        if (this.batches.get(target)?.size)
            this.schedule(target);
    }
    /** Every held wake is tried again; used by the backstop and by terminal events. */
    retryAll() {
        for (const [target, verdicts] of this.batches)
            if (verdicts.size)
                this.schedule(target);
    }
    close() {
        for (const timer of this.timers.values())
            clearTimeout(timer);
        this.timers.clear();
    }
    /** Verdict wakes wait the same beat as reports, and never interrupt a running Turn. */
    schedule(target) {
        if (this.deps.isClosed() || this.timers.has(target) || this.delivering.has(target))
            return;
        const timer = setTimeout(() => {
            this.timers.delete(target);
            this.deps.track(() => this.flush(target));
        }, VERDICT_WAKE_DELAY_MS);
        timer.unref?.();
        this.timers.set(target, timer);
    }
    /**
     * Sends every pending verdict wake for `target` as one Turn, then marks each delivered.
     * A busy target is left holding them: its terminal event or settlement sends them on.
     */
    async flush(target) {
        const batch = this.batches.get(target);
        if (!batch?.size || this.deps.isClosed())
            return;
        const targetSession = await this.deps.options.sessions.get(target);
        // A busy assigner is never interrupted; its wakes wait for that Turn to end.
        if (!targetSession || targetSession.status === 'started')
            return;
        // One Turn answers one chat: wakes of tasks from other chats wait for the next Turn.
        const all = await this.collectPending(batch);
        const first = all[0];
        const pending = first ? all.filter((wake) => channelKey(wake) === channelKey(first)) : [];
        if (!pending.length)
            return;
        this.delivering.add(target);
        try {
            if (await this.submit(target, pending))
                await this.markDelivered(batch, pending);
        }
        finally {
            this.delivering.delete(target);
            if (batch.size)
                this.schedule(target);
        }
    }
    /** The batch's still-unwoken verdicts; one already woken leaves the batch here. */
    async collectPending(batch) {
        const pending = [];
        for (const wake of batch.values()) {
            if (await this.alreadyWoken(wake))
                batch.delete(wake.sessionId);
            else
                pending.push(wake);
        }
        return pending;
    }
    /** Marks each delivered verdict in task history, then drops it from the batch. */
    async markDelivered(batch, pending) {
        for (const wake of pending) {
            // The delivered marker is deduped by the verdict's own idempotency key, so a
            // second flush, a retry or a restart cannot wake the assigner twice.
            await this.deps.options.tasks.appendEvent(wake.sessionId, {
                type: 'task.verdict_delivered',
                payload: {
                    key: wake.key,
                    reviewTaskId: wake.verdict.reviewTaskId,
                    revision: wake.verdict.revision,
                    outcome: wake.verdict.outcome,
                },
                dedupeKey: `${VERDICT_DELIVERED}:${wake.key}`,
            });
            if (batch.get(wake.sessionId)?.key === wake.key)
                batch.delete(wake.sessionId);
            this.deps.onDelivered?.(wake.sessionId);
        }
    }
    /** Whether task history already records this verdict as woken. */
    async alreadyWoken(wake) {
        try {
            const events = await this.deps.options.tasks.listEvents({
                sessionId: wake.sessionId,
                types: [VERDICT_DELIVERED],
            });
            return events.some((event) => event.payload.key === wake.key);
        }
        catch (error) {
            this.deps.options.logger.warn({
                sessionId: wake.sessionId,
                error: error instanceof Error ? error.message : String(error),
            }, 'Verdict delivery history unreadable; sending the wake again');
            return false;
        }
    }
    /** One Turn carrying every pending verdict for this assigner. */
    async submit(target, pending) {
        const origin = verdictWakeOrigin(pending[0]?.originChannel);
        try {
            const result = await this.deps.options.conversation.ingress.submit({
                sessionId: target,
                source: 'communication',
                allowQueue: false,
                message: {
                    content: pending.map((wake) => renderVerdictNotice(wake)).join('\n\n'),
                    attachments: [],
                    ...(origin ? { origin } : {}),
                },
            });
            if ('accepted' in result && result.accepted === false)
                return false;
            return 'turnId' in result;
        }
        catch (error) {
            if (!(error instanceof ConversationTurnRejectedError))
                throw error;
            return false;
        }
    }
}
//# sourceMappingURL=verdict-wake.js.map