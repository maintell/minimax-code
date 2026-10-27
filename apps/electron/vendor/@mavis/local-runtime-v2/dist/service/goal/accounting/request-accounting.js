import { GOAL_BUDGET_WRAP_UP_INSTRUCTION, GOAL_FINAL_REPLY_INSTRUCTION, GOAL_TOKEN_BUDGET_WRAP_UP_INSTRUCTION, } from '@mavis/goal';
import { logger } from '../../../infra/logging/index.js';
import { classifyThreadGoalBindingStale } from '../persistence/binding-stale.js';
import { resolveThreadGoalBudgetLimits, threadGoalBudgetGraceSteps, } from '../lifecycle/gate.js';
/**
 * Counts Goal main execution in logical LLM requests.
 *
 * Every request of a bound Goal Turn passes a durable barrier: it is reserved
 * before it is sent, each attempt's known usage is recorded and charged as
 * the attempt reports it, and the request is settled before the agent loop
 * sees the response. The work budget (`defaultMainTurns`, in work requests)
 * closes the Turn at the next request boundary: the last admitted request's
 * tool calls still run, then at most `graceSteps` tool-less wrap-up requests
 * follow in the same Turn, and then the Turn ends normally.
 */
export class GoalRequestAccounting {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    /** The request barrier of one bound Goal main-execution Turn, or undefined for any other Turn. */
    lifecycleFor(turn) {
        const bound = this.deps.turnContext.getBinding(turn.turnId);
        if (!bound || bound.kind !== 'main' || bound.sessionId !== turn.sessionId)
            return undefined;
        return {
            admit: ({ callId }) => this.admit(turn, callId),
            beforeAttempt: ({ callId, requestAttempt }) => this.deps.store().markRequestDispatching({ requestId: callId, requestAttempt }),
            recordAttempts: ({ callId, attempts }) => this.recordAttempts(callId, attempts),
            settle: (settlement) => this.settle(turn, settlement),
        };
    }
    /**
     * Asked after every step, before the next request: stop once neither a work
     * nor a wrap-up request may follow. Stopping here ends the Turn normally,
     * with no fabricated response.
     */
    async shouldStopAfterStep(turn) {
        return (await this.nextRequest(turn)) === 'stop';
    }
    /**
     * The Turn's ordinary work is over: only wrap-up requests, or none, may
     * follow. User steering that arrives now is handed back to the session for
     * the next Turn instead of being run inside this one (spec §5.5).
     */
    async isWorkClosed(turn) {
        const next = await this.nextRequest(turn);
        return next === 'grace' || next === 'stop';
    }
    async nextRequest(turn) {
        return (await this.nextRequestWithCause(turn)).next;
    }
    /**
     * What the next request of the Turn may be, and which budget closed the
     * Turn's work when it is a wrap-up or a stop. A spent token budget wraps up
     * like a spent request budget: the request count and the per-request token
     * charges are both known before the next request is sent.
     */
    async nextRequestWithCause(turn) {
        const bound = this.deps.turnContext.getBinding(turn.turnId);
        if (!bound || bound.kind !== 'main')
            return { next: 'untracked' };
        const goal = await this.deps.store().getById(bound.binding.goalId);
        // The user deleted the Goal while it was read: the Turn was detached
        // first and goes on as an ordinary Turn.
        if (this.deps.turnContext.getBinding(turn.turnId) !== bound)
            return { next: 'untracked' };
        // A pause or an edit ends the Turn's binding: no further request of this
        // Turn is sent or charged to the Goal (spec §5.1).
        const stale = classifyThreadGoalBindingStale(goal, {
            expectedEpoch: bound.binding.admittedGoalUpdatedAt,
            objectiveDigest: bound.binding.objectiveDigest,
        });
        if (stale || !goal)
            return { next: 'stop' };
        if (!goal.accounting)
            return { next: 'untracked' };
        const closedBy = spentBudget(goal, goal.accounting.workOccupied, this.deps.configGetter);
        if (!closedBy)
            return { next: 'work' };
        const graceSteps = threadGoalBudgetGraceSteps(this.deps.configGetter);
        const graceLeft = this.deps.store().countTurnGraceRequests(turn.turnId) < graceSteps;
        return { next: graceLeft ? 'grace' : 'stop', closedBy };
    }
    async admit(turn, callId) {
        const { next, closedBy } = await this.nextRequestWithCause(turn);
        if (next === 'untracked')
            return { kind: 'send', tools: 'all' };
        if (next === 'stop')
            return { kind: 'stop', reason: 'goal_request_budget_closed' };
        const bound = this.deps.turnContext.getBinding(turn.turnId);
        if (!bound)
            return { kind: 'send', tools: 'all' };
        const reserved = await this.deps.store().reserveRequest({
            requestId: callId,
            goalId: bound.binding.goalId,
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            kind: next,
        });
        // Clients see the in-flight reservation before the request is sent. The
        // projection is display only: a failed read or publish must not leave the
        // reservation behind without a settlement, so it never fails admission.
        if (reserved === 'reserved')
            await this.publishGoalBestEffort(bound.binding.goalId);
        // The user deleted the Goal while the request was being reserved or shown:
        // the Turn goes on as an ordinary Turn and this reservation settles as
        // discarded.
        if (this.deps.turnContext.getBinding(turn.turnId) !== bound) {
            return { kind: 'send', tools: 'all' };
        }
        return next === 'work'
            ? { kind: 'send', tools: 'all' }
            : {
                kind: 'send',
                tools: 'none',
                instruction: this.wrapUpInstruction(turn.turnId, closedBy ?? 'requests'),
            };
    }
    /**
     * After an accepted completion proposal the wrap-up request is the final
     * reply, written to the final-reply requirements; otherwise it summarizes
     * the work that the budget stopped, naming that budget.
     */
    wrapUpInstruction(turnId, closedBy) {
        if (this.deps.turnContext.getSignal(turnId)?.type === 'completion_proposed') {
            return GOAL_FINAL_REPLY_INSTRUCTION;
        }
        return closedBy === 'tokens'
            ? GOAL_TOKEN_BUDGET_WRAP_UP_INSTRUCTION
            : GOAL_BUDGET_WRAP_UP_INSTRUCTION;
    }
    /**
     * Persist and charge the usage known so far, then publish it, so a long
     * Turn's tokens grow with its attempts instead of waiting for settlement.
     */
    async recordAttempts(callId, attempts) {
        const result = await this.deps.store().recordRequestAttempts({ requestId: callId, attempts });
        if (result.kind === 'recorded')
            await this.publishGoalBestEffort(result.goalId);
    }
    async settle(turn, settlement) {
        const result = await this.deps.store().settleRequest({
            requestId: settlement.callId,
            outcome: settlement.outcome,
            attempts: settlement.attempts,
        });
        if (result.kind === 'ignored')
            return;
        if (result.kind === 'discarded') {
            this.deps.emitRuntimeEvent({
                type: 'goal.request_discarded',
                at: this.deps.nowMs(),
                payload: { ...turnPayload(result.goalId, turn, settlement.callId), reason: result.reason },
            });
            return;
        }
        this.deps.emitRuntimeEvent({
            type: 'goal.request_settled',
            at: this.deps.nowMs(),
            payload: {
                ...turnPayload(result.goalId, turn, settlement.callId),
                kind: result.requestKind,
                phase: result.kind === 'applied' ? 'settled' : 'voided',
                outcome: settlement.outcome,
                attempts: settlement.attempts.length,
                tokens: result.kind === 'applied' ? result.tokens : 0,
            },
        });
        // The settlement is committed: a failed projection read must not turn a
        // charged answer into a failed request.
        await this.publishGoalBestEffort(result.goalId);
    }
    async publishGoalBestEffort(goalId) {
        try {
            await this.publishGoal(goalId);
        }
        catch (error) {
            logger.warn({ error, goalId }, 'Thread Goal request projection publish failed');
        }
    }
    async publishGoal(goalId) {
        const goal = await this.deps.store().getById(goalId);
        if (goal)
            this.deps.publishGoal(goal);
    }
}
/** The budget that closed the Goal's ordinary work, if any: requests first, then tokens. */
function spentBudget(goal, workOccupied, configGetter) {
    const limits = resolveThreadGoalBudgetLimits(goal, configGetter);
    if (limits.mainTurns !== null && workOccupied >= limits.mainTurns)
        return 'requests';
    if (limits.tokens !== null && goal.tokensUsed >= limits.tokens)
        return 'tokens';
    return undefined;
}
function turnPayload(goalId, turn, requestId) {
    return { goalId, sessionId: turn.sessionId, turnId: turn.turnId, requestId };
}
//# sourceMappingURL=request-accounting.js.map