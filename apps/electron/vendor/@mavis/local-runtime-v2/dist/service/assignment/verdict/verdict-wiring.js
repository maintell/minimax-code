import { VERDICT_REVIEW_GAVE_UP, VERDICT_REVIEW_RELEASED, verdictReviewTimedOut, verdictUnreadTimedOut, } from '../../coordinator-text/index.js';
import { parseVerdict, } from '../../session-system/index.js';
import { deliveredArtifacts, } from '../contracts.js';
import { underReviewBy } from '../state/assignment-status-facts.js';
import { claimStoredVerdict, recordVerdict, startVerdictReview, verdictGateBlock, } from './verdict-gate.js';
/** An error carrying the code the assignment tools report it under. */
function coded(message, code) {
    return Object.assign(new Error(message), { code });
}
/** Every verdict write, and the conclusion a gated task closes through. */
export class AssignmentVerdictWiring {
    host;
    constructor(host) {
        this.host = host;
    }
    /** What the verdict writes need from this service; every write stays serialized here. */
    verdictStore() {
        return {
            tasks: this.host.options.tasks,
            nowMs: () => this.host.options.nowMs(),
            mark: (id) => this.host.mark(id),
            onRecorded: (id, verdict) => this.host.verdictRecorded(id, verdict),
        };
    }
    /** Whether config.yaml turns the async review gate on for this runtime. */
    verdictGateOn() {
        return this.host.options.verdictGate?.() === true;
    }
    /**
     * Links a review task to the task it checks, so that task's conclusion becomes gated on
     * the review's verdict. Any verdict an earlier review left is dropped.
     */
    async startVerdictReview(input) {
        return this.host.serialize(async () => {
            // Only the task's own assigner, or its current root, may gate its conclusion.
            const caller = await this.host.require(input.callerSessionId);
            const task = await this.host.require(input.sessionId);
            await this.host.requireSummaryAssignment(task, caller);
            return startVerdictReview(this.verdictStore(), input);
        });
    }
    /**
     * Stores a review verdict and wakes the assigner once per verdict.
     *
     * Idempotency is enforced by the store, not by the caller: the same verdict (same review
     * task and revision) delivered twice applies once, and the wake is claimed through a
     * dedupe key so a redelivery never produces a second turn. Nothing here has to be told
     * not to resend.
     */
    async recordVerdict(input) {
        return this.host.serialize(async () => {
            await this.requireVerdictWriter(input.callerSessionId, input.sessionId);
            const result = await recordVerdict(this.verdictStore(), input);
            if (!result.applied)
                this.logDroppedVerdict(input.sessionId, input.verdict);
            return result;
        });
    }
    /**
     * A review task's round ended: its final reply becomes the verdict of the task it checks.
     *
     * The revision is this review task's own, monotonic from 1, so a second round of the same
     * review supersedes the first and its claim, while a redelivery of the same round stores
     * nothing. Unreadable reviewer output is recorded as an inconclusive partial rather than
     * dropped, because a review that said nothing is still news the coordinator has to read.
     */
    async recordReviewerVerdict(input) {
        return this.host.serialize(async () => {
            const caller = await this.host.require(input.reviewTaskId);
            const reviewOf = (await this.host.options.tasks.get(caller.sessionId))?.reviewOf;
            if (!reviewOf)
                throw coded('Only a task dispatched as a review records a verdict', 'ASSIGNMENT_VERDICT_NOT_REVIEWER');
            await this.requireVerdictWriter(caller.sessionId, reviewOf.sessionId);
            const stored = (await this.host.options.tasks.get(reviewOf.sessionId))?.verdict;
            const revision = stored?.reviewTaskId === caller.sessionId ? stored.revision + 1 : 1;
            const verdict = parseVerdict({
                reviewTaskId: caller.sessionId,
                revision,
                source: 'runtime',
                at: input.at,
                text: input.text,
            });
            const result = await recordVerdict(this.verdictStore(), {
                sessionId: reviewOf.sessionId,
                verdict,
            });
            if (!result.applied)
                this.logDroppedVerdict(reviewOf.sessionId, verdict);
            return result;
        });
    }
    /**
     * A dispatched review will not report: release the gate of the task it checks, with the
     * reason the user reads. Only the review actually linked to the task may be abandoned, so a
     * stale sweep can never release a gate a newer review installed.
     */
    async abandonVerdictReview(input) {
        return this.host.serialize(async () => {
            const assignment = await this.host.options.tasks.get(input.sessionId);
            const reviewTask = assignment?.reviewTask;
            if (!reviewTask || reviewTask.sessionId !== input.reviewTaskId)
                return false;
            const abandoned = await this.host.options.tasks.abandonVerdictReview(input.sessionId, {
                reportKey: reviewTask.reportKey,
                reason: input.reason,
                at: input.at,
            });
            if (!abandoned)
                return false;
            this.host.mark(input.sessionId);
            this.host.options.logger.warn({ sessionId: input.sessionId, reviewTaskId: input.reviewTaskId }, 'A dispatched review will not report; the task waits for the user with the reason');
            return true;
        });
    }
    /** Only the review task linked to `sessionId` may write that task's verdict. */
    async requireVerdictWriter(callerSessionId, sessionId) {
        const caller = await this.host.require(callerSessionId);
        const checked = await this.host.require(sessionId);
        const callerTask = await this.host.options.tasks.get(caller.sessionId);
        const checkedTask = await this.host.options.tasks.get(checked.sessionId);
        if (callerTask?.reviewOf?.sessionId !== checked.sessionId ||
            checkedTask?.reviewTask?.sessionId !== caller.sessionId)
            throw coded('Only the review task linked to a task can record its verdict', 'ASSIGNMENT_VERDICT_NOT_REVIEWER');
    }
    /** A verdict the store refused is never silent: the coordinator has to be able to see it. */
    logDroppedVerdict(sessionId, verdict) {
        this.host.options.logger.warn({ sessionId, reviewTaskId: verdict.reviewTaskId, revision: verdict.revision }, 'A review verdict was not stored: the task is closed, or that revision is already stored');
    }
    /**
     * Why this task's conclusion is still held, or undefined when it may be written.
     *
     * The one place the switch is read for the gate: with `bunny.verdictGate` off the gate stops
     * being a gate, so nothing it holds can be left waiting on a verdict that will never land and
     * a release that will never run. `verdictGateBlock` stays a pure reading of the task, which is
     * what its other readers want.
     */
    conclusionBlock(assignment) {
        return this.verdictGateOn() ? verdictGateBlock(assignment) : undefined;
    }
    /**
     * A coordinator turn takes the stored verdict into itself: only the assigner or its current
     * root may, and only a task the gate is holding with a verdict already stored has one.
     *
     * Explicit rather than a side effect of the wake or of concluding. The mechanism exists to
     * make "Bunny read the verdict" provable, and an implicit claim would record it without
     * anyone having read anything. A task whose gate was released keeps its verdict as evidence
     * but has no gate left for a claim to open, so claiming it would write a fact nothing reads;
     * that is refused rather than silently accepted.
     *
     * Returns the verdict itself, so the caller reads it from the same call that records who read
     * it — a claim that hands back nothing would prove nothing.
     */
    async claimVerdict(input) {
        return this.host.serialize(async () => {
            const caller = await this.host.require(input.callerSessionId);
            const task = await this.host.require(input.sessionId);
            await this.host.requireSummaryAssignment(task, caller);
            const assignment = await this.host.options.tasks.get(input.sessionId);
            if (!assignment || assignment.completion || !assignment.reviewTask || !assignment.verdict)
                throw coded('Only a task whose conclusion is gated on a stored review verdict has a verdict to read', 'ASSIGNMENT_VERDICT_NOT_CLAIMABLE');
            const verdict = assignment.verdict;
            const claimed = await claimStoredVerdict(this.verdictStore(), {
                sessionId: input.sessionId,
                by: caller.sessionId,
            });
            // Read back rather than assume: a claim this call did not write (this coordinator already
            // held this revision) keeps whatever was stored, and the caller has to be told who and when.
            const stored = (await this.host.options.tasks.get(input.sessionId))?.verdictClaim;
            return {
                claimed,
                by: stored?.by ?? caller.sessionId,
                at: stored?.at ?? this.host.options.nowMs(),
                revision: stored?.revision ?? verdict.revision,
                verdict,
            };
        });
    }
    /**
     * Closes the exact report Bunny is reviewing now, keeping its conclusion and delivered files.
     *
     * Says what it did rather than returning nothing: a task whose review link is not the report
     * under review, or that carries no review at all, has nothing this can close, and the caller
     * has to be able to tell that apart from a closure that landed.
     */
    closeReviewed(result, callerSessionId) {
        return this.host.serialize(async () => {
            const { sessionId, reportKey } = result;
            const assignment = await this.host.options.tasks.get(sessionId);
            const gateReleased = assignment?.verdictGateReleased !== undefined;
            if (assignment?.completion)
                return { outcome: 'already-closed', gateReleased };
            if (!assignment?.review || !underReviewBy(assignment, callerSessionId, reportKey))
                return { outcome: 'not-written', gateReleased };
            const closed = await this.host.options.tasks.finishReview(sessionId, {
                completion: {
                    state: 'completed',
                    by: 'assigner',
                    at: this.host.options.nowMs(),
                    reason: 'review_passed',
                    summary: result.summary,
                    ...(await deliveredArtifacts(this.host.options.assets, sessionId)),
                },
                clearReportedKey: false,
                result: 'passed',
            });
            if (!closed?.completion)
                return { outcome: 'not-written', gateReleased };
            this.host.mark(sessionId);
            return { outcome: 'written', gateReleased };
        });
    }
    /**
     * Writes every conclusion of a validated batch.
     *
     * A conclusion that wrote nothing used to read as success while the task stayed open for
     * good, with nothing to tell the caller it had. Two things can make that happen, and both
     * are errors now, naming the tasks:
     *
     * - a gated task whose closure the gate refused;
     * - a task whose verdict gate was released. That task never carries `assignment.review` —
     *   the verdict path does not write one — so once the gate is gone it falls into the branch
     *   that has no report to close, and would report success having written nothing. This is
     *   the path the gate's own give-up reasons take, not a rare combination.
     *
     * A task that is already closed, or that no review was ever dispatched for, is left exactly
     * as it was: repeating a conclusion is not a failure, and a task nobody put under review has
     * no conclusion of this kind to write.
     */
    async recordConclusions(results, gated, callerSessionId) {
        const unrecorded = [];
        for (const result of results) {
            if (gated.has(result.sessionId)) {
                if (!(await this.closeGated(result)))
                    unrecorded.push(result.sessionId);
                continue;
            }
            const { outcome, gateReleased } = await this.closeReviewed(result, callerSessionId);
            if (outcome === 'not-written' && gateReleased)
                unrecorded.push(result.sessionId);
        }
        if (unrecorded.length)
            throw coded(`No conclusion was recorded for: ${unrecorded.join(', ')}`, 'ASSIGNMENT_CONCLUSION_NOT_RECORDED');
    }
    /**
     * A verdict-gated task concludes through the gate, not through a report Bunny happened to
     * be reviewing.
     *
     * The verdict path never writes assignment.review, and the wake that brought Bunny here is
     * a Turn of its own whose last round is not the report under review, so neither half of
     * underReviewBy can hold. Returning whether the closure was really written keeps a
     * conclusion that changed nothing from reading as success.
     */
    closeGated(result) {
        return this.host.serialize(async () => {
            const { sessionId } = result;
            const assignment = await this.host.options.tasks.get(sessionId);
            if (!assignment || assignment.completion)
                return false;
            const closed = await this.host.options.tasks.finishReview(sessionId, {
                completion: {
                    state: 'completed',
                    by: 'assigner',
                    at: this.host.options.nowMs(),
                    reason: 'review_passed',
                    summary: result.summary,
                    ...(await deliveredArtifacts(this.host.options.assets, sessionId)),
                },
                clearReportedKey: false,
                result: 'passed',
            });
            if (!closed?.completion)
                return false;
            this.host.mark(sessionId);
            return true;
        });
    }
    /**
     * Everything about this review that can refuse the dispatch, and nothing that writes.
     *
     * The checked task has to exist, the caller has to be allowed to conclude it, and it has to
     * have a finished round to review. The report under review is the one the dispatch named,
     * else the report the checked task last delivered, else the key of its last finished round.
     * A checked task with no finished round has nothing to review: saying so is better than
     * dispatching a review whose gate nothing would ever open.
     *
     * Kept apart from {@link linkVerdictReview} so the create can run it with the other checks
     * that can refuse it, before anything is written. A dispatch that names `takes_over` stops
     * the task it takes over and closes its queue; refusing after that would leave the user with
     * a failed dispatch and a task that is no longer running, with nothing to show for it.
     */
    async checkVerdictReview(caller, reviewOf) {
        const task = await this.host.require(reviewOf.sessionId);
        await this.host.requireSummaryAssignment(task, caller);
        const reportKey = await this.reviewReportKey(reviewOf);
        if (!reportKey)
            throw coded('That task has no finished round to review yet', 'ASSIGNMENT_REVIEW_NO_REPORT');
        return reportKey;
    }
    /**
     * Links a freshly dispatched review task to the task it checks, so that task's conclusion
     * becomes gated on the review's verdict. Any verdict an earlier review left is dropped.
     *
     * Only the write: every check that can refuse the dispatch ran in
     * {@link checkVerdictReview}, before the create touched the disk.
     *
     * Called from inside the create's own serialization, so it writes through the gate directly
     * rather than through the serialized public entry point.
     */
    async linkVerdictReview(reviewOf, reviewTaskId, reportKey) {
        await startVerdictReview(this.verdictStore(), {
            sessionId: reviewOf.sessionId,
            reviewTaskId,
            reportKey,
        });
    }
    /** The report this review checks: the one it names, the one last delivered, or the last round. */
    async reviewReportKey(reviewOf) {
        if (reviewOf.reportKey)
            return reviewOf.reportKey;
        const assignment = await this.host.options.tasks.get(reviewOf.sessionId);
        if (assignment?.lastReportedKey)
            return assignment.lastReportedKey;
        const turn = await this.host.options.facts.lastTurn(reviewOf.sessionId);
        return turn ? `${reviewOf.sessionId}:${turn.turnId}:${turn.state}` : undefined;
    }
}
/** Turning a review round into a verdict, and releasing a gate whose review will never report. */
export class ReportVerdictWiring {
    host;
    /** The assignment service owns every verdict write; bound once it exists. */
    port;
    constructor(host) {
        this.host = host;
    }
    /**
     * The assignment service is built after the report service, so the verdict writes it owns are
     * bound here rather than passed to the constructor. Until then no review round is turned into
     * a verdict, which is also what a runtime with the gate off does.
     */
    bind(port) {
        this.port = port;
    }
    gateOn() {
        return this.switchOn() && this.port !== undefined;
    }
    /** Whether config.yaml turns the async review gate on, whatever else is wired up. */
    switchOn() {
        return this.host.options.verdictGate?.() === true;
    }
    /**
     * A review task's round ended: its output becomes the verdict of the task it checks, or,
     * when the round failed or was stopped, the gate of that task is released so nobody is
     * left waiting behind a gate nothing will open.
     *
     * A round the user started in the review task is neither: someone talking to a review is
     * not the review reporting, and reading their words as a verdict would put a conclusion
     * in the user's mouth.
     *
     * The verdict path is a bypass beside the report path, never a stage of it: a verdict write
     * that throws must not take this round's report, the batch reshuffle or the verdict retries
     * down with it. Those all have their own recovery, and losing them to a failure on this side
     * is worse than a verdict that is stored one backstop tick later.
     */
    async reviewVerdict(event) {
        if (!this.gateOn())
            return;
        await this.guard('reading a finished review round', () => this.readReviewVerdict(event));
    }
    async readReviewVerdict(event) {
        const { sessionId, turnId } = event.payload;
        if (!turnId)
            return;
        const assignment = await this.host.options.tasks.get(sessionId);
        const reviewOf = assignment?.reviewOf;
        if (!reviewOf || assignment?.completion)
            return;
        if (await this.host.userTurn({ sessionId, turnId }))
            return;
        if (event.type !== 'session.finish') {
            await this.releaseVerdictGate(reviewOf.sessionId, sessionId, event.type);
            return;
        }
        const messages = await this.host.options.facts.messages(sessionId, turnId);
        await this.port?.record({
            reviewTaskId: sessionId,
            text: this.host.lastReply(messages),
            at: this.host.options.nowMs(),
        });
    }
    /**
     * Every dispatched review that will not hold a task's conclusion any longer has its gate
     * released, with the reason the user reads.
     *
     * A review that will not report — its task failed, was stopped or closed, its Session is
     * gone, or it ran past the deadline without reporting — releases the gate so no task waits
     * for good. A review that did report keeps its gate until a coordinator turn has read the
     * verdict, bounded by its own horizon below.
     *
     * One task whose cause or release throws must not stop the sweep for the others: the next
     * tick would try them again anyway, and a task that could be released now is better
     * released now.
     */
    async sweep() {
        // Nothing to release through without the assignment service's writes.
        if (!this.port)
            return;
        const switchedOff = !this.switchOn();
        const now = this.host.options.nowMs();
        for (const { sessionId, assignment } of await this.host.options.tasks.list({
            archived: false,
        })) {
            const reviewTask = assignment.reviewTask;
            if (!reviewTask || assignment.completion)
                continue;
            // With the switch off, a gate that is still linked is a gate nothing will ever open: both
            // ways out — a verdict landing and the deadline — are switched off with it, while the
            // readers of `reviewTask` do not consult the switch. Leaving it in place would hold the
            // task shut for good. So the link is released here, with a reason the user reads; the
            // verdict stays as evidence and nothing is ever concluded by it.
            const cause = switchedOff
                ? 'switched-off'
                : await this.guard('reading why a review gave up', () => this.reviewGaveUpCause(assignment, reviewTask, now));
            if (!cause)
                continue;
            await this.guard('releasing a verdict gate', () => this.releaseVerdictGate(sessionId, reviewTask.sessionId, cause));
        }
    }
    /** Why this review will not hold the task's conclusion any longer, or undefined while it might. */
    async reviewGaveUpCause(assignment, reviewTask, now) {
        // A review that already stored a verdict has reported. Whatever became of its own task —
        // it reported back and was closed, it was archived, its Session is gone — the gate must
        // not be torn down for a review that never reported: doing so turns a task whose review
        // succeeded into `review_failed` and quietly takes the verdict path's own conclusion with
        // it. The only thing still missing is a coordinator turn that read the verdict, so that is
        // the only thing that can run out of time, and it is measured from the verdict itself: a
        // review that took 25 of its 30 minutes to report gets the full horizon to be read, not
        // the minutes it left over.
        const verdict = assignment.verdict;
        if (verdict) {
            // What this horizon waits for is a coordinator turn that read the verdict, and a claim of
            // this very revision is exactly that. Once it exists the wait is over, whatever the clock
            // says: Bunny reading a verdict and then waiting for the user to decide is a normal state,
            // not a verdict nobody read. Counting time alone called that state 'unread', released the
            // gate, turned a passing review into `review_failed` and deleted the claim that disproved
            // it — so the clock only runs while the verdict really is unread.
            //
            // Revision-bound, like every other reader of a claim (verdictGateBlock, verdictStatus): a
            // claim of an older verdict says nothing about this one. A newer verdict drops the claim
            // outright, so this holds even if one ever outlives its revision.
            const claim = assignment.verdictClaim;
            if (claim && claim.revision === verdict.revision)
                return undefined;
            return now - verdict.at >= this.host.reviewTimeoutMs ? 'unread' : undefined;
        }
        const lost = await this.reviewWillNotReport(reviewTask.sessionId);
        if (lost)
            return lost;
        // Nothing has gone wrong; only the deadline from the link can end this wait.
        return now - reviewTask.at >= this.host.reviewTimeoutMs ? 'timeout' : undefined;
    }
    /** Why this review will not report at all, or undefined while it still might. */
    async reviewWillNotReport(reviewTaskId) {
        const review = await this.host.options.sessions.get(reviewTaskId);
        if (!review || review.archived)
            return 'missing';
        if ((await this.host.options.tasks.get(reviewTaskId))?.completion)
            return 'closed';
        const last = await this.host.options.facts.lastTurn(reviewTaskId);
        if (!last || last.state === 'completed')
            return undefined;
        // A round the user started is not the review reporting. The event path already refuses to
        // read one as a verdict; reading one here as a give-up would let anyone unlock a gate by
        // typing in the review task and stopping the round. Both paths apply one rule to one round.
        if (await this.host.userTurn({ sessionId: reviewTaskId, turnId: last.turnId }))
            return undefined;
        return last.state === 'stopped' ? 'session.abort' : 'session.error';
    }
    /** The verdict path never fails the report path beside it; what broke is logged and nothing else. */
    async guard(what, run) {
        try {
            return await run();
        }
        catch (error) {
            this.host.options.logger.warn({ error: error instanceof Error ? error.message : String(error) }, `The verdict path failed while ${what}; the report path is untouched`);
            return undefined;
        }
    }
    /** Releases one gate with a reason whose first line is written for the user. */
    async releaseVerdictGate(sessionId, reviewTaskId, cause) {
        await this.port?.abandon({
            sessionId,
            reviewTaskId,
            reason: `${this.gaveUpHeadline(cause)}；${VERDICT_REVIEW_RELEASED}`,
            at: this.host.options.nowMs(),
        });
    }
    gaveUpHeadline(cause) {
        switch (cause) {
            case 'session.error':
                return VERDICT_REVIEW_GAVE_UP.failed;
            case 'session.abort':
                return VERDICT_REVIEW_GAVE_UP.stopped;
            case 'timeout':
                return verdictReviewTimedOut(Math.round(this.host.reviewTimeoutMs / 60_000));
            case 'unread':
                return verdictUnreadTimedOut(Math.round(this.host.reviewTimeoutMs / 60_000));
            case 'switched-off':
                return VERDICT_REVIEW_GAVE_UP.switchedOff;
            case 'missing':
                return VERDICT_REVIEW_GAVE_UP.missing;
            case 'closed':
                return VERDICT_REVIEW_GAVE_UP.closed;
        }
    }
}
//# sourceMappingURL=verdict-wiring.js.map