/**
 * Charges a full-usage Goal the requests that are not its main execution:
 * automatic compaction inside a Goal Turn, and every request of a sub-session
 * round a Goal Turn started (spec §2.2–2.8).
 *
 * A round's Goal is fixed when the round is asked for, while the Turn that
 * asked for it can still be told apart: a bound Goal Turn, a Goal Turn the
 * Goal ran (the subagent verifier is started after its Goal Turn ended), or a
 * round already attributed (descendants). The pairing is kept in this process
 * only, so it survives the parent Turn, a pause, an edit and completion, and
 * is gone after a restart: a round that can no longer be attributed charges
 * nothing and nothing is estimated. A queued round keeps its pairing when the
 * queue runs it under a fresh Turn id, and a round's pairing is dropped once
 * its Turn settles. Usage of a deleted Goal is discarded at
 * the store, never moved to the Session's next Goal.
 *
 * Charging only counts: no request is admitted, refused or narrowed here, so
 * a Goal's token budget never stops a sub-session. Its charges feed the
 * budget checks of the Goal's main execution like any other usage.
 */
import { logger } from '../../../infra/logging/index.js';
/** Task kinds whose rounds are model work a Goal pays for (spec §2.3). */
const CHARGED_TASK_KINDS = new Set(['subagent', 'workflow']);
export class GoalTokenCharging {
    deps;
    /** Round Turn id → the Goal its requests are charged to. */
    roundGoals = new Map();
    constructor(deps) {
        this.deps = deps;
    }
    /**
     * `parentTurnId` asked for the round `childTurnId`. Charged to a Goal only
     * when the parent Turn is that Goal's Turn, or a round already charged to
     * it, and the Goal is metered on full usage. Never throws.
     */
    async attributeRound(input) {
        if (!this.deps.isEnabled())
            return;
        if (input.kind !== undefined && !CHARGED_TASK_KINDS.has(input.kind))
            return;
        try {
            const goalId = await this.goalOfTurn(input.parentSessionId, input.parentTurnId);
            if (!goalId)
                return;
            const goal = await this.deps.store().getById(goalId);
            if (!goal?.tokenUsage)
                return;
            this.roundGoals.set(input.childTurnId, goalId);
        }
        catch (error) {
            logger.warn({ ...input, error: error instanceof Error ? error.message : String(error) }, 'Goal could not attribute a sub-session round; its usage is not charged');
        }
    }
    /** A requested round never started as its own Turn, or its Turn has settled. */
    forgetRound(childTurnId) {
        this.roundGoals.delete(childTurnId);
    }
    /**
     * The queue runs a requested round as `turnId` instead of the id it was asked
     * for (a redelivery after a refused attempt). The round keeps the Goal fixed
     * when it was asked for; the Session's current Goal is never looked up again.
     */
    transferRound(input) {
        for (const previous of input.previousTurnIds) {
            const goalId = this.roundGoals.get(previous);
            if (!goalId)
                continue;
            this.roundGoals.delete(previous);
            this.roundGoals.set(input.turnId, goalId);
        }
    }
    /**
     * The recorder of a Turn whose requests a Goal is charged for: every request
     * of an attributed round, or the automatic compaction of a bound Goal Turn
     * (its own requests go through the request ledger).
     */
    usageRecorderFor(turn) {
        if (!this.deps.isEnabled())
            return undefined;
        const roundGoalId = this.roundGoals.get(turn.turnId);
        if (roundGoalId)
            return this.recorder(roundGoalId, turn, 'sub_session');
        const goalId = this.deps.turnContext.goalIdForTurn(turn.sessionId, turn.turnId);
        return goalId ? this.recorder(goalId, turn, 'compaction') : undefined;
    }
    async goalOfTurn(sessionId, turnId) {
        const round = this.roundGoals.get(turnId);
        if (round)
            return round;
        const bound = this.deps.turnContext.goalIdForTurn(sessionId, turnId);
        if (bound)
            return bound;
        const goal = await this.deps.store().getBySession(sessionId);
        return goal && this.deps.turnHistory.has(goal.goalId, turnId) ? goal.goalId : undefined;
    }
    recorder(goalId, turn, base) {
        const charge = async (input) => {
            // A Goal Turn's own requests are the ledger's; only its compaction is charged here.
            if (base === 'compaction' && input.scope !== 'compaction')
                return;
            const result = await this.deps.store().chargeTokens({
                requestId: input.callId,
                goalId,
                sessionId: turn.sessionId,
                turnId: turn.turnId,
                source: input.scope === 'compaction' ? 'compaction' : base,
                attempts: input.attempts,
                ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
            });
            if (result.kind !== 'charged')
                return;
            if (result.tokens === 0 && input.outcome === undefined)
                return;
            const goal = await this.deps.store().getById(goalId);
            if (goal)
                this.deps.publishGoal(goal);
        };
        // Charging never fails a request; a store failure is only reported.
        const chargeOrReport = async (input) => {
            try {
                await charge(input);
            }
            catch (error) {
                logger.warn({
                    goalId,
                    callId: input.callId,
                    sessionId: turn.sessionId,
                    turnId: turn.turnId,
                    error: error instanceof Error ? error.message : String(error),
                }, 'Goal could not record the token usage of a request');
            }
        };
        return {
            recordAttempts: (input) => chargeOrReport(input),
            settle: (input) => chargeOrReport(input),
        };
    }
}
//# sourceMappingURL=token-charging.js.map