import { logger } from '../common/logger.js';
/**
 * Error text the ask_user call rejects with when the Turn is stopped while a
 * sync questionnaire waits. pi-agent-core records it as this call's error
 * result; the questionnaire itself stays pending and answerable.
 */
export const QUESTIONNAIRE_SYNC_WAIT_STOPPED_MESSAGE = 'The user stopped the task while this question was waiting for an answer. The question is still open and may be answered later.';
/** How often a sync wait re-reads the session's steering and queue. */
const DEFAULT_PROBE_POLL_MS = 300;
/**
 * Process-local table of ask_user calls waiting inside their Turn for a v2
 * sync questionnaire. There is at most one waiter per session (the Turn is
 * blocked in this tool), but the table is keyed by requestId because
 * reply/dismiss address a questionnaire. A restart loses every entry by
 * design: the Turn is recovered by the normal rules and later answers go
 * through steer.
 */
export class QuestionnaireSyncWaitRegistry {
    options;
    entries = new Map();
    deliveringAnswers = new Set();
    isDeliveringAnswer(requestId) {
        return this.deliveringAnswers.has(requestId);
    }
    finishAnswerDelivery(requestId) {
        this.deliveringAnswers.delete(requestId);
    }
    constructor(options = {}) {
        this.options = options;
    }
    /**
     * Called by the lifecycle after the row is persisted and before
     * `questionnaire.ask` goes out, so an answer racing the tool's `wait()`
     * lands in the buffer instead of taking the steer path while the Turn
     * blocks on this very call. Also fixes the "new message" cut-off time.
     */
    reserve(requestId, sessionId) {
        if (this.entries.has(requestId))
            return;
        this.entries.set(requestId, { requestId, sessionId, sinceMs: this.now() });
    }
    /**
     * Drops a reservation whose wait will never run or has ended (begin failed,
     * tool finished). A no-op while a wait is active. Returns a buffered outcome
     * nobody took so the caller can decide what to do with it; an answer left
     * there keeps `injected_at` empty and is redelivered by recovery.
     */
    release(requestId, reason) {
        const entry = this.entries.get(requestId);
        if (!entry || entry.waiter)
            return undefined;
        this.entries.delete(requestId);
        this.deliveringAnswers.delete(requestId);
        const fields = { requestId, sessionId: entry.sessionId, responseMode: 'sync', reason };
        if (entry.buffered) {
            logger.warn({ ...fields, droppedOutcome: entry.buffered.kind }, 'Questionnaire sync wait reservation released with an untaken outcome');
            return entry.buffered;
        }
        logger.info(fields, 'Questionnaire sync wait reservation released');
        return undefined;
    }
    has(requestId) {
        return this.entries.has(requestId);
    }
    /** Reservations with an already buffered outcome no longer await input. */
    isAwaitingReply(requestId) {
        const entry = this.entries.get(requestId);
        return entry !== undefined && entry.buffered === undefined;
    }
    wait(input) {
        const fields = { requestId: input.requestId, sessionId: input.sessionId, responseMode: 'sync' };
        const existing = this.entries.get(input.requestId);
        if (existing?.buffered) {
            this.entries.delete(input.requestId);
            logger.info({ ...fields, reason: existing.buffered.kind }, 'Questionnaire sync wait ended before the tool started waiting');
            return Promise.resolve(existing.buffered);
        }
        if (input.signal?.aborted) {
            this.entries.delete(input.requestId);
            logger.info({ ...fields, reason: 'stop' }, 'Questionnaire sync wait ended');
            return Promise.reject(new Error(QUESTIONNAIRE_SYNC_WAIT_STOPPED_MESSAGE));
        }
        const entry = existing ?? {
            requestId: input.requestId,
            sessionId: input.sessionId,
            sinceMs: this.now(),
        };
        this.entries.set(input.requestId, entry);
        return new Promise((resolve, reject) => {
            let settled = false;
            let polling = false;
            const failedProbes = new Set();
            let timer;
            const cleanup = () => {
                settled = true;
                if (timer)
                    clearInterval(timer);
                input.signal?.removeEventListener('abort', onAbort);
                if (this.entries.get(input.requestId) === entry)
                    this.entries.delete(input.requestId);
            };
            const onAbort = () => {
                if (settled)
                    return;
                cleanup();
                // Stop aborts the whole Turn; no message is injected and no Turn is
                // started. The questionnaire stays pending and can be answered later.
                logger.info({ ...fields, reason: 'stop' }, 'Questionnaire sync wait ended');
                reject(new Error(QUESTIONNAIRE_SYNC_WAIT_STOPPED_MESSAGE));
            };
            entry.waiter = {
                settle: (outcome) => {
                    if (settled)
                        return;
                    cleanup();
                    logger.info({ ...fields, reason: outcome.kind }, 'Questionnaire sync wait ended');
                    resolve(outcome);
                },
            };
            input.signal?.addEventListener('abort', onAbort, { once: true });
            // Fail open: a broken probe must not end the wait (the user can still
            // answer, skip or stop). Logged once per probe per wait: probes run
            // every few hundred ms and would otherwise flood the log.
            const probe = async (name, read) => {
                if (!read)
                    return false;
                try {
                    return (await read()) === true;
                }
                catch (error) {
                    if (!failedProbes.has(name)) {
                        failedProbes.add(name);
                        logger.warn({ ...fields, probe: name, reason: 'probe_failed', err: error }, 'Questionnaire sync wait probe failed');
                    }
                    return false;
                }
            };
            const steering = input.hasPendingUserSteering;
            const queued = input.hasQueuedUserInputSince;
            if (!steering || !queued) {
                logger.warn({ ...fields, reason: 'probe_missing', steeringProbe: !!steering, queueProbe: !!queued }, 'Questionnaire sync wait cannot detect every kind of new user message on this host');
            }
            if (steering || queued) {
                timer = setInterval(() => {
                    if (settled || polling)
                        return;
                    polling = true;
                    void (async () => {
                        // Steering first: that message is already in this Turn, so the
                        // model handles it right away (different tool result text).
                        if (await probe('steering', steering)) {
                            entry.waiter?.settle({ kind: 'new_message' });
                        }
                        else if (await probe('queue', queued && (() => queued(entry.sinceMs)))) {
                            entry.waiter?.settle({ kind: 'new_message_queued' });
                        }
                    })().finally(() => {
                        polling = false;
                    });
                }, this.options.probePollMs ?? DEFAULT_PROBE_POLL_MS);
                timer.unref?.();
            }
            logger.info({ ...fields, sinceMs: entry.sinceMs }, 'Questionnaire sync wait started');
        });
    }
    /**
     * Hands a user answer to the ask_user call. `delivered`: the waiting call
     * now returns it. `buffered`: the call has not started waiting yet and will
     * take it from the buffer. `no_waiter`: nobody waits; use steer.
     */
    settleAnswered(requestId, reply) {
        const settlement = this.settle(requestId, { kind: 'answered', reply, buffered: true });
        if (settlement !== 'no_waiter' &&
            reply.answers.some((answer) => answer.contextImages?.length)) {
            this.deliveringAnswers.add(requestId);
        }
        return settlement;
    }
    /** Skip / close: ends the wait without changing the questionnaire status. */
    settleDismissed(requestId) {
        return this.settle(requestId, { kind: 'dismissed' }) !== 'no_waiter';
    }
    settle(requestId, outcome) {
        const entry = this.entries.get(requestId);
        if (!entry)
            return 'no_waiter';
        const fields = { requestId, sessionId: entry.sessionId, responseMode: 'sync' };
        if (entry.waiter) {
            // A live waiter returns the answer now, so the buffered marker is dropped.
            entry.waiter.settle(outcome.kind === 'answered' ? { kind: 'answered', reply: outcome.reply } : outcome);
            return 'delivered';
        }
        if (entry.buffered) {
            // The first outcome wins; a later one (e.g. dismiss after an answer)
            // takes its normal path instead.
            logger.info({
                ...fields,
                reason: 'buffer_occupied',
                buffered: entry.buffered.kind,
                ignored: outcome.kind,
            }, 'Questionnaire sync wait outcome not buffered');
            return 'no_waiter';
        }
        entry.buffered = outcome;
        logger.info({ ...fields, reason: outcome.kind }, 'Questionnaire sync wait outcome buffered before wait started');
        return 'buffered';
    }
    now() {
        return (this.options.nowMs ?? Date.now)();
    }
}
//# sourceMappingURL=sync-wait-registry.js.map