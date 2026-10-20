import { buildThreadGoalKickoffMessage, threadGoalKickoffClientRequestId } from './kickoff.js';
/** Owns initial Goal kickoff materialization, replacement, recovery, and cancellation. */
export class GoalInitialKickoffCoordinator {
    deps;
    /** Serialize retirement and rewrites so rapid PATCHes cannot restore an older Goal epoch. */
    refreshTails = new Map();
    /*
     * Goals whose queued kickoff was cancelled for a rewrite but not yet
     * re-delivered.
     *
     * `reconcile` otherwise reads `enqueued` with nothing in the Queue as "the
     * kickoff was delivered and consumed". That inference is right for a normal
     * delivery, but a rewrite whose re-enqueue failed leaves exactly the same
     * shape while the kickoff — and the one-shot attachment snapshot it carries —
     * has never run. Remembering the cancel keeps the delivery responsibility
     * with this coordinator until an enqueue actually succeeds.
     */
    awaitingRedelivery = new Set();
    constructor(deps) {
        this.deps = deps;
    }
    async reconcile(goal, dispatch, refreshQueued = false) {
        if (goal.status === 'paused') {
            const current = await this.retireAfterPause(goal, dispatch);
            return current?.kickoffState ?? goal.kickoffState;
        }
        const clientRequestId = threadGoalKickoffClientRequestId(goal.goalId);
        let queued = await this.deps.external.hasPendingInitialContinuation(goal.sessionId, clientRequestId);
        if (goal.status === 'complete' || goal.kickoffState === 'consumed') {
            if (queued)
                await this.deps.external.cancelInitialContinuation(goal.sessionId, clientRequestId);
            if (goal.kickoffState !== 'consumed')
                await this.consume(goal);
            return 'consumed';
        }
        if (!queued &&
            goal.kickoffState === 'pending' &&
            (goal.turnsUsed > 0 || this.deps.hasActiveTurn(goal))) {
            await this.consume(goal);
            return 'consumed';
        }
        if (goal.kickoffState === 'enqueued' && !queued && !this.awaitingRedelivery.has(goal.goalId)) {
            await this.consume(goal);
            return 'consumed';
        }
        if (refreshQueued && queued && goal.status === 'active') {
            await this.deps.external.cancelInitialContinuation(goal.sessionId, clientRequestId);
            // From here the kickoff owes a re-delivery, and only a successful enqueue
            // below discharges it.
            this.awaitingRedelivery.add(goal.goalId);
            queued = await this.deps.external.hasPendingInitialContinuation(goal.sessionId, clientRequestId);
        }
        if (!queued) {
            const prompt = await this.deps.preparePrompt(goal);
            try {
                await this.deps.external.enqueueInitialContinuationTurn(goal, buildThreadGoalKickoffMessage(goal, prompt.content, goal.kickoffAttachments.map((attachment) => ({ ...attachment }))), clientRequestId, prompt.internalPromptRead);
            }
            catch (error) {
                // A persisted receipt owns the work even if submission lost its ACK.
                if (!(await this.deps.external.hasPendingInitialContinuation(goal.sessionId, clientRequestId))) {
                    const current = await this.deps.store().getById(goal.goalId);
                    if (this.deps.hasActiveTurn(goal) ||
                        (current?.turnsUsed ?? 0) > 0 ||
                        current?.kickoffState === 'consumed') {
                        await this.consume(current ?? goal);
                        this.awaitingRedelivery.delete(goal.goalId);
                        return 'consumed';
                    }
                    throw error;
                }
                this.deps.external.reportFailure(goal.sessionId, `thread_goal_kickoff_ack_failed:${this.deps.external.formatError(error)}`);
            }
        }
        this.awaitingRedelivery.delete(goal.goalId);
        if (goal.kickoffState === 'pending') {
            try {
                await this.deps.store().transitionKickoffState(goal.goalId, 'pending', 'enqueued');
            }
            catch (error) {
                // Queue admission has committed. Recovery can repair this bookkeeping.
                this.deps.external.reportFailure(goal.sessionId, `thread_goal_kickoff_state_failed:${this.deps.external.formatError(error)}`);
            }
        }
        if (dispatch)
            this.deps.external.requestQueueDispatch(goal.sessionId);
        return 'enqueued';
    }
    /** Rebuild a queued kickoff from the newest durable Goal after a decision-epoch advance. */
    async refreshQueuedKickoff(observed) {
        try {
            return await this.serialize(observed.sessionId, async () => {
                const current = await this.deps.store().getBySession(observed.sessionId);
                if (!current || current.goalId !== observed.goalId || current.status !== 'active') {
                    return undefined;
                }
                // A concurrent pause may have retired the kickoff while this PATCH
                // waited its turn. Resume that Goal through the ordinary continuation.
                if (current.kickoffState === 'consumed')
                    return current;
                await this.reconcile(current, true, true);
                const refreshed = await this.deps.store().getBySession(observed.sessionId);
                return refreshed?.goalId === observed.goalId ? refreshed : undefined;
            });
        }
        catch (error) {
            this.deps.external.reportFailure(observed.sessionId, `thread_goal_kickoff_refresh_failed:${this.deps.external.formatError(error)}`);
            // Failed queue rewrites must retain redelivery responsibility.
            throw error;
        }
    }
    /**
     * A paused Goal owns no runnable kickoff. Retire the marker before removing
     * its Queue item: even an already-claimed item then fails admission and cannot
     * pin the FIFO head. The Goal/objective/attachment snapshot remains durable;
     * explicit resume uses a new continuation, carrying first-turn attachments.
     */
    async retireAfterPause(observed, dispatch = true) {
        try {
            return await this.serialize(observed.sessionId, async () => {
                const current = await this.deps.store().getBySession(observed.sessionId);
                if (!current || current.goalId !== observed.goalId || current.status !== 'paused')
                    return current;
                await this.consume(current);
                try {
                    await this.cancel(current);
                }
                finally {
                    if (dispatch)
                        this.deps.external.requestQueueDispatch(current.sessionId);
                }
                return this.deps.store().getBySession(current.sessionId);
            });
        }
        catch (error) {
            this.deps.external.reportFailure(observed.sessionId, `thread_goal_kickoff_retire_failed:${this.deps.external.formatError(error)}`);
            return undefined;
        }
    }
    async serialize(sessionId, operation) {
        const result = (this.refreshTails.get(sessionId) ?? Promise.resolve()).then(operation);
        const tail = result.then(() => undefined, () => undefined);
        this.refreshTails.set(sessionId, tail);
        try {
            return await result;
        }
        finally {
            if (this.refreshTails.get(sessionId) === tail)
                this.refreshTails.delete(sessionId);
        }
    }
    async rollbackFailedCreation(goal) {
        if (this.deps.hasActiveTurn(goal))
            return;
        const current = await this.deps.store().getById(goal.goalId);
        if (current && (current.updatedAt !== goal.updatedAt || current.kickoffState !== 'pending'))
            return;
        if (await this.deps.external.hasPendingInitialContinuation(goal.sessionId, threadGoalKickoffClientRequestId(goal.goalId)))
            return;
        await this.deps.store().delete(goal.goalId);
    }
    cancel(goal) {
        return this.cancelByGoal(goal.sessionId, goal.goalId);
    }
    cancelByGoal(sessionId, goalId) {
        return this.deps.external.cancelInitialContinuation(sessionId, threadGoalKickoffClientRequestId(goalId));
    }
    async consumeDelivered(goal) {
        if (goal.kickoffState !== 'enqueued')
            return;
        const clientRequestId = threadGoalKickoffClientRequestId(goal.goalId);
        if (await this.deps.external.hasPendingInitialContinuation(goal.sessionId, clientRequestId)) {
            return;
        }
        await this.consume(goal);
    }
    async consume(goal) {
        if (goal.kickoffState === 'consumed')
            return;
        await this.deps.store().transitionKickoffState(goal.goalId, goal.kickoffState, 'consumed');
    }
}
//# sourceMappingURL=initial-kickoff.js.map