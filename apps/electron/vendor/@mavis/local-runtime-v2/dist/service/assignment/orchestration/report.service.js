import { executionLocationLabel } from './execution-location.js';
import { BUNNY_AGENT_NAME } from '../../bunny/index.js';
import { escapeAssignmentData, FULL_REPLY_TOKENS, PREVIEW_EDGE_TOKENS, renderTaskReport as renderTaskReportText, replyOmissionLine, replyPreviewNote, REVIEW_FAILURE_CAUSE, REVIEW_STOPPED, reviewGaveUp, ROUND_INTERRUPTED_BY_RESTART, } from '../../coordinator-text/index.js';
import { DEFAULT_SPACE_NAME, isAssignedByBunny, stoppedByRestart, } from '../../session-system/index.js';
import { refusalCooldownMs } from '@mavis/agent-core/pi-turn-runner';
import { ConversationTurnRejectedError } from '@mavis/conversation-contract';
import { createDefaultTokenEstimator } from '@mavis/context-manager';
import { classifyFinishStepError } from '@mavis/shared/llm-error-classifier';
import { deliveredArtifacts, } from '../contracts.js';
import { taskErrorReason } from '../state/task-error-reason.js';
import { VerdictWakeDelivery } from '../verdict/verdict-wake.js';
/**
 * A review that does not finish (its turn fails, or a restart interrupts it)
 * redelivers its report at most this many times. The count is persisted on the
 * assignment, so restarting the runtime does not reset it.
 */
const MAX_REVIEW_RETRIES = 2;
/**
 * The backstop for a report or review that an event should have moved on and
 * did not. Every few minutes the service looks for a finished task whose report
 * never went out or whose review never closed, and tries once more, at most
 * MAX_BACKSTOP_RETRIES times per report. A question still waiting for its answer
 * spends nothing: it is not a miss, and its answer or dismissal moves the task on.
 * The count is process memory; a restart recovers these tasks through `ready`.
 */
const BACKSTOP_INTERVAL_MS = 5 * 60_000;
const MAX_BACKSTOP_RETRIES = 6;
/**
 * Owns observation, restart recovery, coalescing and delivery. A coordinator
 * gets its reports as a Turn of their own: while it runs a Turn they wait in
 * their batch and go out once that Turn has ended (3.3), never into it.
 */
/** Round end states that report back to the assigner. */
const REPORTED_ROUND_STATES = new Set([
    'completed',
    'failed',
    'stopped',
]);
export class AssignmentReportService {
    options;
    onDelivered;
    batches = new Map();
    /** Verdict wakes: separate from report batches, a wake is not a task report. */
    verdicts;
    reported = new Set();
    /**
     * Bunny sessions that asked a questionnaire in the turn now running. A session
     * runs one turn at a time, so an ask seen since its last start belongs to the
     * turn that finishes next. Only such a question holds that review open.
     */
    askedThisTurn = new Set();
    /**
     * Failed rounds of Bunny's tasks whose report reached Bunny: the task and the
     * Bunny Turn handling its error. A failure has no review to record; process
     * memory only, like a held report.
     */
    handling = new Map();
    /** Backstop retries spent per report; only reports still outstanding stay here. */
    backstopRetries = new Map();
    backstopTimer;
    unsubscribe;
    work = Promise.resolve();
    closed = false;
    constructor(options, onDelivered) {
        this.options = options;
        this.onDelivered = onDelivered;
        this.verdicts = new VerdictWakeDelivery({
            options,
            reportTarget: (assignment) => this.reportTarget(assignment),
            track: (run) => this.track(run),
            isClosed: () => this.closed,
            onDelivered,
        });
        this.unsubscribe = options.events.subscribe({
            next: (event) => this.track(() => this.observe(event)),
        });
    }
    failed(signal) {
        this.track(() => this.capture({ ...signal, state: 'failed' }));
    }
    /**
     * Whether this task's finished round has a report the coordinator has not
     * received yet. Process memory only; restart recovery captures it again.
     */
    awaiting(sessionId) {
        for (const batch of this.batches.values())
            if (batch.pending.has(sessionId))
                return true;
        return false;
    }
    /**
     * Whether Bunny is about to check or is handling this task's last round: its
     * report waits to reach Bunny, or the failed round's report is in Bunny's
     * Turn. A round the user started is not Bunny's to check. The review of a
     * finished round is on the task itself.
     */
    reviewing(sessionId) {
        if (this.handling.has(sessionId))
            return true;
        for (const batch of this.batches.values()) {
            const pending = batch.pending.get(sessionId);
            if (pending && checkedByBunny(pending))
                return true;
        }
        return false;
    }
    /**
     * A Turn of `sessionId` has settled. When it was a coordinator holding
     * reports, they go out now: its terminal event may have come while the
     * Session still read as running.
     */
    settled(sessionId) {
        const batch = this.batches.get(sessionId);
        if (batch?.pending.size)
            this.schedule(sessionId, batch);
        this.verdicts.settled(sessionId);
    }
    /**
     * A review verdict was stored: wake the checked task's assigner in a Turn of its own,
     * so Bunny reads the verdict, tells the user, and only then concludes the task.
     *
     * Call this only for a verdict the store actually applied. Redelivery safety does not
     * rely on that: a verdict already marked delivered in task history is never woken
     * again, so a retry after a crash cannot produce a second Turn.
     */
    verdictRecorded(sessionId, verdict) {
        this.verdicts.recorded(sessionId, verdict);
    }
    async ready() {
        this.startBackstop();
        for (const { sessionId, assignment } of await this.options.tasks.list({ archived: false })) {
            if (!assignment.reportBack)
                continue;
            const session = await this.options.sessions.get(sessionId);
            if (!session || session.archived || session.status === 'started')
                continue;
            if (assignment.review &&
                !(await this.recoverReview({ session, assignment })))
                continue;
            await this.recoverRound(session);
        }
    }
    /**
     * Reports the task's last round if the previous process did not. A round the
     * app's restart cut off goes back to Bunny as a failed round, once for its
     * Turn; it is never run again by itself.
     */
    async recoverRound(session, detail) {
        const last = await this.options.facts.lastTurn(session.sessionId);
        if (!last)
            return;
        const interrupted = stoppedByRestart(session);
        if (interrupted)
            await this.appendRound(session.sessionId, last.turnId, 'interrupted');
        await this.capture({
            sessionId: session.sessionId,
            turnId: last.turnId,
            state: last.state,
            key: `${session.sessionId}:${last.turnId}:${last.state}`,
            ...(interrupted ? { detail: ROUND_INTERRUPTED_BY_RESTART, interrupted } : {}),
            ...(!interrupted && detail ? { detail } : {}),
        });
    }
    startBackstop() {
        if (this.closed || this.backstopTimer)
            return;
        this.backstopTimer = setInterval(() => this.track(() => this.runBackstop()), BACKSTOP_INTERVAL_MS);
        this.backstopTimer.unref?.();
    }
    async runBackstop() {
        const outstanding = new Set();
        for (const { sessionId, assignment } of await this.options.tasks.list({ archived: false })) {
            if (!assignment.reportBack)
                continue;
            try {
                const key = await this.retryTask(sessionId, assignment);
                if (key)
                    outstanding.add(key);
            }
            catch (error) {
                this.options.logger.warn({ sessionId, error: error instanceof Error ? error.message : String(error) }, 'Assignment report retry failed');
            }
        }
        for (const key of this.backstopRetries.keys())
            if (!outstanding.has(key))
                this.backstopRetries.delete(key);
        for (const coordinatorId of new Set([...this.handling.values()].map((e) => e.coordinatorId)))
            if (await this.heldReviewEnd(coordinatorId))
                this.releaseHandling(coordinatorId);
        // A verdict wake held by a busy assigner is retried here too.
        this.verdicts.retryAll();
    }
    /** One task's backstop retry. Returns the key of the report still outstanding. */
    async retryTask(sessionId, assignment) {
        const session = await this.options.sessions.get(sessionId);
        if (!session || session.archived)
            return undefined;
        if (assignment.review) {
            const task = { session, assignment };
            const end = await this.heldReviewEnd(task.assignment.review.sessionId);
            if (!end || (await this.options.facts.status(session)).pendingQuestionCount)
                return undefined;
            const key = task.assignment.review.reportKey;
            if (this.spendBackstopRetry(sessionId, key))
                await this.closeHeldReview(task, end);
            return key;
        }
        const key = await this.unreportedRound(session, assignment);
        if (key && this.spendBackstopRetry(sessionId, key))
            await this.recoverRound(session, session.errorMessage);
        return key;
    }
    spendBackstopRetry(sessionId, key) {
        const spent = this.backstopRetries.get(key) ?? 0;
        if (spent >= MAX_BACKSTOP_RETRIES)
            return false;
        this.backstopRetries.set(key, spent + 1);
        if (spent + 1 === MAX_BACKSTOP_RETRIES)
            this.options.logger.warn({ sessionId, reportKey: key }, 'Assignment report retries are spent; it waits for the next event or restart');
        return true;
    }
    /**
     * The key of the task's last round when it finished and never reported. Null
     * when a report for it went out, the task moved on, or something still holds
     * it: a question or approval waiting for the user, or a next round in the queue.
     */
    async unreportedRound(session, assignment) {
        const last = await this.settledRound(session, assignment);
        if (!last)
            return undefined;
        // A failure is news once per assignment (reportKey), whatever its error reads now.
        const reported = assignment.lastReportedKey;
        const failurePrefix = `${session.sessionId}:${assignment.assignedAt}:failed:`;
        if (last.state === 'failed' &&
            !stoppedByRestart(session) &&
            reported?.startsWith(failurePrefix))
            return undefined;
        const key = `${session.sessionId}:${last.turnId}:${last.state}`;
        return reported === key || this.reported.has(key) ? undefined : key;
    }
    /** The task's last round, when it finished and nothing still holds the task. */
    async settledRound(session, assignment) {
        if (assignment.completion || assignment.pendingStart || !roundEnded(session))
            return undefined;
        const last = await this.options.facts.lastTurn(session.sessionId);
        if (!last || (last.state !== 'completed' && last.state !== 'failed'))
            return undefined;
        const status = await this.options.facts.status(session);
        return status.state === last.state && !status.pendingQuestionCount ? last : undefined;
    }
    /**
     * How a review held after its Turn ended comes out, once its coordinator is
     * idle with no question left to wait for. A running Turn ends it by event.
     */
    async heldReviewEnd(coordinatorId) {
        const coordinator = await this.options.sessions.get(coordinatorId);
        if (!coordinator || coordinator.status === 'started')
            return undefined;
        if ((await this.options.facts.status(coordinator)).pendingQuestionCount)
            return undefined;
        const last = await this.options.facts.lastTurn(coordinatorId);
        return last && HELD_REVIEW_END[last.state];
    }
    closeHeldReview(task, type) {
        return this.finishReview(task, { type, payload: { turnId: task.assignment.review.turnId } });
    }
    /** A failure Bunny did not handle before its Turn ended now waits for the user. */
    releaseHandling(coordinatorId) {
        for (const entry of [...this.handling.values()])
            if (entry.coordinatorId === coordinatorId)
                this.endHandling(coordinatorId, entry.turnId);
    }
    /**
     * The user skipped a question, so what it held moves on now: a coordinator's
     * reviews close, and a finished task reports. An answer needs none of this: it
     * starts a Turn of its own, whose events carry the task on.
     */
    async questionDismissed(sessionId) {
        const session = await this.options.sessions.get(sessionId);
        if (!session)
            return;
        if (session.agentName === BUNNY_AGENT_NAME)
            await this.closeHeldReviews(session.sessionId);
        const assignment = await this.options.tasks.get(sessionId);
        if (!assignment?.reportBack || session.archived)
            return;
        if (assignment.review)
            return this.closeHeldReviews(assignment.review.sessionId);
        if (await this.unreportedRound(session, assignment))
            await this.recoverRound(session, session.errorMessage);
    }
    async closeHeldReviews(coordinatorId) {
        const end = await this.heldReviewEnd(coordinatorId);
        if (!end)
            return;
        for (const task of await this.reviewingTasks(coordinatorId))
            await this.closeHeldReview(task, end);
        this.releaseHandling(coordinatorId);
    }
    /**
     * The previous process ended this review before it finished. Returns whether
     * the report should be captured again; a review still running is left alone.
     */
    async recoverReview(task) {
        const coordinator = await this.options.sessions.get(task.assignment.review.sessionId);
        if (coordinator?.status === 'started')
            return false;
        const retry = this.reviewRetry(task, true);
        await this.options.tasks.finishReview(task.session.sessionId, {
            ...(retry.reviewRetries ? { reviewRetries: retry.reviewRetries } : {}),
            ...(retry.gaveUp
                ? { reviewError: this.reviewError(task.assignment.review, { restart: true }) }
                : {}),
            clearReportedKey: retry.retry,
            result: 'failed',
        });
        return retry.retry;
    }
    async close() {
        this.closed = true;
        this.unsubscribe();
        if (this.backstopTimer)
            clearInterval(this.backstopTimer);
        for (const batch of this.batches.values())
            if (batch.timer)
                clearTimeout(batch.timer);
        this.verdicts.close();
        await this.work;
    }
    track(run) {
        const previous = this.work;
        this.work = (async () => {
            await previous;
            if (this.closed)
                return;
            try {
                await run();
            }
            catch (error) {
                this.options.logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Assignment report operation failed');
            }
        })();
    }
    async observe(event) {
        // A new round of a task leaves the error Bunny was handling behind.
        if (event.type === 'session.start')
            this.handling.delete(event.payload.sessionId);
        if (isSkipEvent(event))
            return this.questionDismissed(event.payload.sessionId);
        if (isTerminalEvent(event))
            await this.recordRound(event);
        await this.reviewEvent(event);
        const signal = reportSignal(event);
        if (signal)
            await this.capture(signal);
        if (isTerminalEvent(event)) {
            // A terminal may free a target whose reports were held while it ran.
            for (const [target, batch] of this.batches)
                if (batch.pending.size)
                    this.schedule(target, batch);
            this.verdicts.retryAll();
        }
    }
    /** Every finished round of a task enters its history once, whoever started it. */
    async recordRound(event) {
        const { sessionId, turnId } = event.payload;
        if (!turnId)
            return;
        const state = ROUND_STATE[event.type];
        const written = await this.appendRound(sessionId, turnId, state, roundErrorKind(event));
        // The stop reaches the panel and timeline here; its report goes out through capture().
        if (written && state === 'aborted')
            this.onDelivered?.(sessionId);
    }
    async appendRound(sessionId, turnId, state, errorKind) {
        const initiator = (await this.userTurn({ sessionId, turnId })) ? 'user' : 'assigner';
        return this.options.tasks.appendEvent(sessionId, {
            type: 'task.round_ended',
            payload: { turnId, state, initiator, ...(errorKind ? { errorKind } : {}) },
            dedupeKey: `round:${sessionId}:${turnId}`,
        });
    }
    async reviewEvent(event) {
        if (event.type === 'questionnaire.ask')
            return this.noteAsk(event);
        if (event.type !== 'session.start' && !isTerminalEvent(event))
            return;
        const coordinator = await this.options.sessions.get(event.payload.sessionId);
        if (coordinator?.agentName !== BUNNY_AGENT_NAME)
            return;
        const asked = this.askedThisTurn.delete(coordinator.sessionId);
        const tasks = await this.reviewingTasks(coordinator.sessionId);
        if (event.type === 'session.start') {
            this.resumeHandling(coordinator.sessionId, event.payload.turnId);
            return this.resumeReview(tasks, event.payload.turnId);
        }
        // Only a question asked in this turn waits for its answer. An older question still
        // pending from an earlier turn has nothing to do with this review and must not hold it.
        if (event.type === 'session.finish' &&
            asked &&
            (await this.options.facts.status(coordinator)).pendingQuestionCount > 0)
            return;
        for (const task of tasks)
            await this.finishReview(task, event);
        this.endHandling(coordinator.sessionId, event.payload.turnId);
    }
    /** The answer to Bunny's question carries the handling of a failure on in a new Turn. */
    resumeHandling(coordinatorId, turnId) {
        if (!turnId)
            return;
        for (const entry of this.handling.values())
            if (entry.coordinatorId === coordinatorId)
                entry.turnId = turnId;
    }
    /**
     * Bunny's Turn ended without sending the task on or closing it: the error is
     * one Bunny did not handle, and it now waits for the user.
     */
    endHandling(coordinatorId, turnId) {
        for (const [sessionId, entry] of this.handling) {
            if (entry.coordinatorId !== coordinatorId || entry.turnId !== turnId)
                continue;
            this.handling.delete(sessionId);
            this.onDelivered?.(sessionId);
        }
    }
    /** A recovery redelivery after restart re-shows an old question; it was not asked now. */
    async noteAsk(event) {
        if (event.payload.deliveryReason === 'recovery')
            return;
        const session = await this.options.sessions.get(event.payload.sessionId);
        if (session?.agentName === BUNNY_AGENT_NAME)
            this.askedThisTurn.add(session.sessionId);
    }
    /** Open tasks whose report this coordinator is reviewing. */
    async reviewingTasks(coordinatorId) {
        const tasks = [];
        for (const { sessionId, assignment } of await this.options.tasks.list({
            archived: false,
            reviewSessionId: coordinatorId,
        })) {
            if (assignment.review?.sessionId !== coordinatorId || assignment.completion)
                continue;
            const session = await this.options.sessions.get(sessionId);
            if (session && !session.archived)
                tasks.push({ session, assignment: assignment });
        }
        return tasks;
    }
    async resumeReview(tasks, turnId) {
        if (!turnId)
            return;
        // A questionnaire answer resumes review in a new Turn without a duplicate report.
        for (const task of tasks)
            await this.options.tasks.resumeReview(task.session.sessionId, turnId);
    }
    /**
     * A successful review closes the task. A failed review redelivers a bounded
     * number of times, then gives up. A stopped review did not get done either:
     * it gives up at once, since the user stopped it (R6.4). A review that gave
     * up keeps the task open with its report marked as delivered: the report is
     * already in the coordinator's history, so nothing restarts it, here or after
     * a restart, and the task waits for the user with the reason.
     */
    async finishReview(task, event) {
        const assignment = task.assignment;
        const review = assignment.review;
        if (review.turnId !== event.payload.turnId)
            return;
        const success = event.type === 'session.finish';
        if (success && (await this.options.facts.status(task.session)).state !== 'completed')
            return;
        const { retry, reviewRetries, gaveUp } = this.reviewRetry(task, event.type === 'session.error');
        const sessionId = task.session.sessionId;
        const reviewError = this.givenUp(review, event, gaveUp === true);
        await this.options.tasks.finishReview(sessionId, {
            ...(reviewRetries ? { reviewRetries } : {}),
            ...(success ? { completion: await this.reviewedCompletion(task) } : {}),
            ...(reviewError ? { reviewError } : {}),
            clearReportedKey: retry,
            result: REVIEW_RESULT[event.type],
        });
        this.onDelivered?.(sessionId);
        if (retry)
            await this.redeliver(sessionId, review.reportKey, reviewCooldownMs(event));
    }
    /** Bunny's review ended without a conclusion: the report's summary stands for it. */
    async reviewedCompletion(task) {
        return {
            state: 'completed',
            by: 'assigner',
            at: this.options.nowMs(),
            reason: 'review_passed',
            summary: task.assignment.review.summary,
            ...(await deliveredArtifacts(this.options.assets, task.session.sessionId)),
        };
    }
    /**
     * Only an unfinished review is retried, a bounded number of times per report.
     * The returned count is persisted with the assignment; a finished, stopped or
     * exhausted review clears it. An exhausted one gives up: the task then waits
     * for the user with the reason (R6.4).
     */
    reviewRetry(task, unfinished) {
        const key = task.assignment.review.reportKey;
        const spent = task.assignment.reviewRetries?.reportKey === key ? task.assignment.reviewRetries.count : 0;
        if (unfinished && spent < MAX_REVIEW_RETRIES)
            return { retry: true, reviewRetries: { reportKey: key, count: spent + 1 } };
        if (!unfinished)
            return { retry: false };
        this.options.logger.warn({ sessionId: task.session.sessionId, reportKey: key }, 'Assignment review kept failing; the report waits for the user');
        return { retry: false, gaveUp: true };
    }
    /** A stopped review gives up at once; an unfinished one once its retries are spent. */
    givenUp(review, event, exhausted) {
        if (event.type === 'session.abort')
            return this.reviewError(review, { stopped: true });
        if (!exhausted)
            return undefined;
        const error = event.type === 'session.error' ? event.payload.error : undefined;
        return this.reviewError(review, error ? { error } : {});
    }
    /** Why the review gave up; the first line is written for the user. */
    reviewError(review, failure) {
        const detail = failure.error?.trim();
        const headline = failure.stopped
            ? REVIEW_STOPPED
            : reviewGaveUp(reviewFailureCause(failure.restart === true, detail), MAX_REVIEW_RETRIES);
        return {
            reportKey: review.reportKey,
            reason: detail ? `${headline}\n${detail}` : headline,
            at: this.options.nowMs(),
        };
    }
    /** A retry of a review a refusal cool-down failed waits `cooldownMs` before it goes out. */
    async redeliver(sessionId, deliveredKey, cooldownMs) {
        this.reported.delete(deliveredKey);
        const last = await this.options.facts.lastTurn(sessionId);
        if (last)
            await this.capture({
                sessionId,
                turnId: last.turnId,
                state: last.state,
                key: `${sessionId}:${last.turnId}:${last.state}`,
            }, cooldownMs === undefined ? undefined : this.options.nowMs() + cooldownMs);
    }
    /**
     * Every finished, failed or stopped round reports back, marked with who started it. A
     * round the user started in the task is never reviewed: when it ends
     * normally the task closes here as completed by the user (R5.3).
     */
    async capture(signal, notBeforeMs) {
        if (!REPORTED_ROUND_STATES.has(signal.state))
            return;
        const task = await this.reportable(signal.sessionId);
        if (task && (await this.options.facts.status(task.session)).pendingQuestionCount)
            return;
        const key = reportKey(task?.assignment, signal);
        const initiator = (await this.userTurn(signal)) ? 'user' : 'assigner';
        if (!canReport(task, { key, reported: this.reported, initiator, state: signal.state }))
            return;
        const { session } = task;
        const target = await this.reportTarget(task.assignment);
        if (!target)
            return;
        const made = await this.makePending(session, task.assignment, { ...signal, key }, initiator);
        const pending = await this.closeUserRound(made);
        const batch = this.batches.get(target) ?? newBatch();
        batch.pending.set(session.sessionId, pending);
        this.batches.set(target, batch);
        if (notBeforeMs !== undefined)
            holdBatch(batch, notBeforeMs);
        // The task now waits for its report to reach the assigner; its status shows that.
        this.onDelivered?.(session.sessionId);
        this.schedule(target, batch);
    }
    /** Where a report goes: the assigner, or the current root when it was the root. */
    async reportTarget(assignment) {
        const assigner = await this.options.sessions.get(assignment.assignerSessionId);
        if (!assigner)
            return undefined;
        return assignment.assignerWasRoot
            ? this.options.agents.currentRoot(assignment.assignerAgentName)
            : this.currentTarget(assigner);
    }
    /** Whether the user typed this round's input in the task; an unreadable source reads as Bunny's. */
    async userTurn(signal) {
        if (!signal.turnId)
            return false;
        try {
            return (await this.options.facts.startedByUser?.(signal.sessionId, signal.turnId)) === true;
        }
        catch (error) {
            this.options.logger.warn({ error: error instanceof Error ? error.message : String(error), ...signal }, 'Assignment round source unreadable; reporting it as the assigner round');
            return false;
        }
    }
    /** The user's own round ended normally: the task is done, by the user. */
    async closeUserRound(pending) {
        const { assignment, item } = pending;
        if (item.initiator !== 'user' || item.state !== 'completed' || assignment.completion)
            return pending;
        const closed = await this.options.tasks.close(item.sessionId, {
            state: 'completed',
            by: 'user',
            at: this.options.nowMs(),
            reason: 'user_round',
            summary: firstSentence(pending.text),
            ...(await deliveredArtifacts(this.options.assets, item.sessionId)),
        });
        return closed ? { ...pending, assignment: closed } : pending;
    }
    async reportable(sessionId) {
        const session = await this.options.sessions.get(sessionId);
        const assignment = session && (await this.options.tasks.get(sessionId));
        return session && assignment ? { session, assignment } : undefined;
    }
    async makePending(session, assignment, signal, initiator) {
        const messages = signal.turnId
            ? await this.options.facts.messages(session.sessionId, signal.turnId)
            : [];
        const item = {
            worklineId: this.options.worklines.sessionSpace(session.sessionId),
            sessionId: session.sessionId,
            title: session.title ?? '',
            projectName: executionLocationLabel(session),
            state: signal.state,
            initiator,
            ...(signal.detail ? { detail: signal.detail } : {}),
        };
        const spaceName = (await this.options.worklines.list()).find((space) => space.id === item.worklineId)?.name ??
            DEFAULT_SPACE_NAME;
        const assets = await this.options.assets(session.sessionId, signal.turnId);
        return {
            item,
            turnId: signal.turnId,
            assignment,
            key: signal.key,
            text: lastReply(messages),
            spaceName,
            assets,
        };
    }
    schedule(target, batch) {
        if (this.closed || batch.timer || batch.delivering)
            return;
        const now = this.options.nowMs();
        while (batch.deliveries.length && (batch.deliveries[0] ?? 0) <= now - 60_000)
            batch.deliveries.shift();
        const nextAvailable = (batch.deliveries[0] ?? now) + 60_000 - now;
        const delay = Math.max(batch.deliveries.length >= 3 ? Math.max(2000, nextAvailable) : 2000, (batch.notBeforeMs ?? now) - now);
        batch.timer = setTimeout(() => {
            batch.timer = undefined;
            this.track(() => this.flush(target, batch));
        }, delay);
        batch.timer.unref?.();
    }
    currentTarget(assigner) {
        if (assigner.sessionType === 'root' || assigner.origin === 'root-repair')
            return this.options.agents.currentRoot(assigner.agentName);
        return Promise.resolve(assigner.sessionId);
    }
    async redirect(target, batch, session) {
        const rootAssignment = [...batch.pending.values()].find((pending) => pending.assignment.assignerWasRoot)?.assignment;
        const currentTarget = rootAssignment
            ? await this.options.agents.currentRoot(rootAssignment.assignerAgentName)
            : await this.currentTarget(session);
        if (currentTarget === target)
            return false;
        const current = this.batches.get(currentTarget) ?? newBatch(batch.deliveries);
        for (const [id, pending] of batch.pending)
            if (!current.pending.has(id))
                current.pending.set(id, pending);
        if (batch.notBeforeMs !== undefined)
            holdBatch(current, batch.notBeforeMs);
        batch.pending.clear();
        this.batches.set(currentTarget, current);
        this.schedule(currentTarget, current);
        return true;
    }
    async flush(target, batch) {
        if (!batch.pending.size || this.closed)
            return;
        const targetSession = await this.options.sessions.get(target);
        if (!targetSession)
            return;
        if (await this.redirect(target, batch, targetSession))
            return;
        // A busy assigner is never interrupted: its reports wait for that Turn to end and
        // go out on its terminal event or settlement (3.3).
        if (targetSession.status === 'started')
            return;
        const items = await this.currentReports(batch);
        if (!items.length)
            return;
        batch.delivering = true;
        let held = false;
        try {
            // The reports are a Turn of their own, never sent through the visible Session queue.
            // An assigner that cannot take them now keeps them here until its next terminal event.
            const delivery = await this.deliver(target, items);
            held = delivery.kind === 'held';
            if (delivery.kind !== 'delivered')
                return;
            const { turnId } = delivery;
            batch.deliveries.push(this.options.nowMs());
            for (const pending of items)
                await this.acknowledge(batch, pending, target, turnId);
        }
        finally {
            this.finishDelivery(target, batch, held);
        }
    }
    finishDelivery(target, batch, held) {
        batch.delivering = false;
        if (batch.pending.size && !held)
            this.schedule(target, batch);
    }
    reportMessage(items) {
        return {
            content: items.map(renderTaskReport).join('\n\n'),
            attachments: [],
            origin: { assignmentReport: { items: items.map(({ item }) => item) } },
        };
    }
    async deliver(target, items) {
        try {
            const result = await this.options.conversation.ingress.submit({
                sessionId: target,
                source: 'communication',
                allowQueue: false,
                message: this.reportMessage(items),
            });
            if ('accepted' in result && result.accepted === false)
                return { kind: 'held' };
            return 'turnId' in result ? { kind: 'delivered', turnId: result.turnId } : { kind: 'held' };
        }
        catch (error) {
            if (!(error instanceof ConversationTurnRejectedError))
                throw error;
            return { kind: error.reason === 'compaction-active' ? 'compacting' : 'held' };
        }
    }
    async currentReports(batch) {
        const current = [];
        for (const pending of batch.pending.values()) {
            const task = await this.reportable(pending.item.sessionId);
            if (canReport(task, {
                key: pending.key,
                reported: this.reported,
                initiator: pending.item.initiator,
                state: pending.item.state,
            }) &&
                sameAssignment(task.assignment, pending.assignment))
                current.push(pending);
            else
                batch.pending.delete(pending.item.sessionId);
        }
        return current;
    }
    async acknowledge(batch, pending, target, turnId) {
        this.reported.add(pending.key);
        if (this.reported.size > 1000) {
            const oldest = this.reported.values().next().value;
            if (oldest)
                this.reported.delete(oldest);
        }
        const checked = checkedByBunny(pending);
        // Only the round this report was made for records it; a newer send keeps its own state.
        await this.options.tasks.recordReport(pending.item.sessionId, pending.assignment, {
            reportKey: pending.key,
            ...reportRound(pending),
            // Only Bunny's own round is reviewed; the user's round is not an approval to check.
            ...(checked && pending.item.state === 'completed'
                ? {
                    review: {
                        sessionId: target,
                        turnId,
                        reportKey: pending.key,
                        summary: firstSentence(pending.text),
                    },
                }
                : {}),
        });
        if (checked && pending.item.state === 'failed')
            this.handling.set(pending.item.sessionId, { coordinatorId: target, turnId });
        if (batch.pending.get(pending.item.sessionId)?.key === pending.key)
            batch.pending.delete(pending.item.sessionId);
        this.onDelivered?.(pending.item.sessionId);
    }
}
/** Bunny checks its own rounds of its own tasks; the user's round is not Bunny's to check. */
function checkedByBunny(pending) {
    return isAssignedByBunny(pending.assignment) && pending.item.initiator === 'assigner';
}
/**
 * A v2 skip: the question stays pending and answerable but has `dismissedAt`
 * set, so it no longer holds the task. Later state events of the same question
 * (answered, injected) also carry `dismissedAt`; only a pending one is the skip.
 */
function isSkipEvent(event) {
    return (event.type === 'questionnaire.state' &&
        event.payload.state.status === 'pending' &&
        event.payload.state.dismissedAt !== undefined);
}
const REVIEW_RESULT = {
    'session.finish': 'passed',
    'session.error': 'failed',
    'session.abort': 'stopped',
};
/** The terminal event a review held past its Turn would have seen, by how that Turn ended. */
const HELD_REVIEW_END = {
    completed: 'session.finish',
    failed: 'session.error',
    stopped: 'session.abort',
};
const ROUND_STATE = {
    'session.finish': 'completed',
    'session.error': 'failed',
    'session.abort': 'aborted',
};
/**
 * Why a failed round failed, kept in its history only as a closed enum: `network` when the
 * error reads as a lost connection, nothing otherwise. The error text itself is not stored.
 */
function roundErrorKind(event) {
    if (event.type !== 'session.error')
        return undefined;
    const { error, errorCode } = event.payload;
    const reason = classifyFinishStepError({
        ...(typeof error === 'string' ? { errorMessage: error } : {}),
        ...(typeof errorCode === 'number' ? { statusCode: errorCode } : {}),
    });
    return reason === 'network' ? 'network' : undefined;
}
/**
 * The round a report carries in the task's own history. A stopped round has none: `recordRound`
 * already wrote it as `aborted`, so recording it again here would double the entry.
 */
function reportRound(pending) {
    const state = pending.item.state;
    if (!pending.turnId || (state !== 'completed' && state !== 'failed'))
        return {};
    return { round: { turnId: pending.turnId, state } };
}
/** What stopped a review, in the user's words. */
function reviewFailureCause(restart, detail) {
    if (restart)
        return REVIEW_FAILURE_CAUSE.restart;
    if (detail && /timed?\s*out|timeout|超时/i.test(detail))
        return REVIEW_FAILURE_CAUSE.timeout;
    return REVIEW_FAILURE_CAUSE.failed;
}
/** Holds a batch until `notBeforeMs`; a delivery already scheduled sooner is moved back. */
function holdBatch(batch, notBeforeMs) {
    if ((batch.notBeforeMs ?? 0) >= notBeforeMs)
        return;
    batch.notBeforeMs = notBeforeMs;
    if (batch.timer)
        clearTimeout(batch.timer);
    batch.timer = undefined;
}
/** The refusal cool-down a failed review names, if any (dogfood fixes spec 5.4). */
function reviewCooldownMs(event) {
    return event.type === 'session.error' ? refusalCooldownMs(event.payload.error) : undefined;
}
function newBatch(deliveries = []) {
    return { pending: new Map(), deliveries, delivering: false };
}
function sameAssignment(current, expected) {
    return (current?.assignedAt === expected.assignedAt &&
        current.assignerSessionId === expected.assignerSessionId);
}
/**
 * A completion is news on every turn. A failure is news once: the same error repeated by later
 * turns of the same assignment would only make the assigner say "nothing new". A new follow-up
 * (new assignedAt) makes the same error news again. A round the restart cut off is news once for
 * its Turn: another restart does not report it again, a later interrupted round does.
 */
function reportKey(assignment, signal) {
    const assignedAt = assignment?.assignedAt;
    if (signal.state !== 'failed' || signal.interrupted || assignedAt === undefined)
        return signal.key;
    const error = (signal.detail ?? '').split(/\r?\n/)[0].trim().slice(0, 200);
    return `${signal.sessionId}:${assignedAt}:failed:${error}`;
}
/** An open task reports; so does the user's round that just closed it. */
function canReport(task, gate) {
    if (!task || task.session.archived || !roundEnded(task.session, gate.state))
        return false;
    const assignment = task.assignment;
    const completion = assignment.completion;
    return (assignment.reportBack === true &&
        (!completion || (gate.initiator === 'user' && completion.reason === 'user_round')) &&
        assignment.lastReportedKey !== gate.key &&
        !gate.reported.has(gate.key));
}
/**
 * Whether the task's last round ended and reports. A completed or failed round ended by itself,
 * or by the app's restart when nobody stopped it. A stopped round ended the moment its abort
 * event arrived, so a state read that still sees the admitted Turn does not hold its report
 * back; the app's own restart is the one stop that stays out, since `recoverRound` reports that
 * round as a failed one at startup.
 */
function roundEnded(session, state) {
    if (state === 'stopped')
        return !stoppedByRestart(session);
    if (session.status === 'started')
        return false;
    if (session.status === 'aborted' || session.status === 'interrupted')
        return stoppedByRestart(session);
    return true;
}
/** @internal Exported only for focused tests. */
export function lastReply(messages) {
    for (const message of [...messages].reverse()) {
        const body = message.msg_content ?? message.msgContent ?? message.content;
        if (message.role !== 'assistant' || typeof body !== 'string' || !body.trim())
            continue;
        return body;
    }
    return '';
}
function isTerminalEvent(event) {
    return (event.type === 'session.finish' ||
        event.type === 'session.error' ||
        event.type === 'session.abort');
}
function reportSignal(event) {
    switch (event.type) {
        case 'session.finish':
            return terminalSignal(event.payload, 'completed');
        case 'session.error':
            return terminalSignal(event.payload, 'failed');
        // A stopped round reports too: without this the assigner never learns the task
        // stopped and its card waits for a conclusion that never comes.
        case 'session.abort':
            return terminalSignal(event.payload, 'stopped');
        default:
            return undefined;
    }
}
function firstSentence(text) {
    return text.trim().match(/^[^。！？.!?\n]+[。！？.!?]?/u)?.[0] ?? '';
}
function renderTaskReport({ item, assignment, text, spaceName, assets }) {
    const safe = escapeAssignmentData;
    return renderTaskReportText({
        title: safe(item.title),
        spaceName: safe(spaceName),
        projectName: safe(item.projectName),
        sessionId: safe(item.sessionId),
        initiator: item.initiator,
        ...(item.state === 'failed' ? { error: safe(taskErrorReason(item.detail ?? '')) } : {}),
        ...(item.state === 'stopped' ? { stopped: true } : {}),
        goal: safe(assignment.goal ?? ''),
        criteria: (assignment.doneWhen ?? []).map(safe),
        finalReply: finalReply(text, item.sessionId).map(safe),
        files: assets.map((asset) => safe(asset.path)),
    });
}
/**
 * The final reply as the review turn sees it: whole up to 4k tokens, else a
 * head and tail preview that says where the full text is and how to read it.
 *
 * @internal Exported only for focused tests.
 */
export function finalReply(text, sessionId) {
    const estimator = createDefaultTokenEstimator();
    const tokens = estimator.estimateTextTokens(text);
    if (tokens <= FULL_REPLY_TOKENS)
        return [text];
    const head = fitTokens(text, PREVIEW_EDGE_TOKENS, 'head');
    const tail = fitTokens(text.slice(head.length), PREVIEW_EDGE_TOKENS, 'tail');
    return [
        head,
        replyOmissionLine(tokens - estimator.estimateTextTokens(head + tail)),
        tail,
        replyPreviewNote(tokens, sessionId),
    ];
}
/** The longest head or tail of `text` within `limit` estimated tokens. */
function fitTokens(text, limit, end) {
    const estimator = createDefaultTokenEstimator();
    const piece = (length) => end === 'head' ? text.slice(0, length) : text.slice(text.length - length);
    let low = 0;
    let high = text.length;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (estimator.estimateTextTokens(piece(middle)) <= limit)
            low = middle;
        else
            high = middle - 1;
    }
    // Never split a surrogate pair at the cut.
    const cut = end === 'head' ? low : text.length - low;
    if (cut > 0 && cut < text.length && /[\uDC00-\uDFFF]/.test(text.charAt(cut)))
        low -= 1;
    return piece(low);
}
function terminalSignal(payload, state) {
    return {
        sessionId: payload.sessionId,
        turnId: payload.turnId,
        state,
        key: `${payload.sessionId}:${payload.turnId}:${state}`,
        ...(payload.error ? { detail: payload.error } : {}),
    };
}
//# sourceMappingURL=report.service.js.map