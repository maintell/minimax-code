/** Owns all per-Turn Goal bindings, accounting receipts, and model proposals. */
export class GoalTurnContextRegistry {
    bindings = new Map();
    accounting = new Map();
    signals = new Map();
    breakerDecisions = new Map();
    detachedTurns = new Map();
    getBinding(turnId) {
        return this.bindings.get(turnId);
    }
    setBinding(turnId, binding) {
        this.bindings.set(turnId, binding);
    }
    deleteBinding(turnId) {
        this.bindings.delete(turnId);
    }
    /**
     * The user deleted the Goal this running Turn works for: the Turn goes on as
     * an ordinary Turn. Everything that tied it to the Goal goes now, before the
     * Turn settles, so its later requests, tools and settlement see no binding.
     * The Turn is remembered as detached until its terminal event asks. Returns
     * what was removed, for `reattach` when the deletion fails.
     */
    detach(sessionId, turnId) {
        const binding = this.bindings.get(turnId);
        if (binding?.sessionId !== sessionId)
            return undefined;
        const detached = {
            binding,
            accounting: this.accounting.get(turnId),
            signal: this.signals.get(turnId),
            breakerDecision: this.breakerDecisions.get(turnId),
        };
        this.bindings.delete(turnId);
        this.accounting.delete(turnId);
        this.signals.delete(turnId);
        this.breakerDecisions.delete(turnId);
        this.detachedTurns.set(turnId, sessionId);
        return detached;
    }
    /**
     * The deletion that detached the Turn failed: the Turn works for its Goal
     * again, with the proposal and accounting it had, as if never detached.
     */
    reattach(sessionId, turnId, detached) {
        if (this.detachedTurns.get(turnId) !== sessionId)
            return;
        this.detachedTurns.delete(turnId);
        this.bindings.set(turnId, detached.binding);
        if (detached.accounting)
            this.accounting.set(turnId, detached.accounting);
        if (detached.signal)
            this.signals.set(turnId, detached.signal);
        if (detached.breakerDecision)
            this.breakerDecisions.set(turnId, detached.breakerDecision);
    }
    /**
     * Whether the user's deletion detached this Turn from its Goal, answered once:
     * the Turn's terminal event asks after settlement has already dropped every
     * other trace of the Turn, so the answer is kept until then and released here.
     */
    takeDetached(sessionId, turnId) {
        if (this.detachedTurns.get(turnId) !== sessionId)
            return false;
        this.detachedTurns.delete(turnId);
        return true;
    }
    /**
     * The Goal this Session's Turn executes for: the binding admission committed,
     * whatever source queued the Turn (a Goal continuation or a reply to the
     * Goal's questionnaire). Undefined for any other Turn, and once the Turn has
     * settled. Every "is this Turn Goal X's Goal Turn" question asks this.
     */
    goalIdForTurn(sessionId, turnId) {
        const bound = this.bindings.get(turnId);
        return bound?.kind === 'main' && bound.sessionId === sessionId
            ? bound.binding.goalId
            : undefined;
    }
    /** A Goal Turn of this session is bound and not finished, running or not yet. */
    hasBindingInSession(sessionId) {
        for (const binding of this.bindings.values()) {
            if (binding.sessionId === sessionId)
                return true;
        }
        return false;
    }
    getAccounting(turnId) {
        return this.accounting.get(turnId);
    }
    hasAccounting(turnId) {
        return this.accounting.has(turnId);
    }
    setAccounting(turnId, accounting) {
        this.accounting.set(turnId, accounting);
    }
    getSignal(turnId) {
        return this.signals.get(turnId)?.signal;
    }
    /**
     * The breaker is a persisted counter, not a pure function of the Turn: it
     * advances the Goal epoch when it writes. A settlement retry (for example
     * after a transient continuation enqueue failure) reuses the accounting
     * receipt captured before that write, so re-running the breaker would either
     * count the same Turn twice or fail its CAS against its own epoch. Cache the
     * decision per Turn instead and replay it.
     */
    getBreakerDecision(turnId) {
        return this.breakerDecisions.get(turnId)?.decision;
    }
    setBreakerDecision(turnId, sessionId, decision) {
        this.breakerDecisions.set(turnId, { sessionId, decision });
    }
    collectSignal(turnId, signal) {
        const boundTurn = this.bindings.get(turnId);
        if (!boundTurn)
            return 'not_a_goal_turn';
        if (boundTurn.kind !== 'main' ||
            boundTurn.binding.goalId !== signal.goalId ||
            boundTurn.binding.objectiveDigest !== signal.objectiveDigest) {
            return 'stale';
        }
        const previous = this.signals.get(turnId)?.signal;
        if (!previous || previous.type !== 'block_proposed' || signal.type === 'block_proposed') {
            this.signals.set(turnId, { sessionId: boundTurn.sessionId, signal });
        }
        return 'accepted';
    }
    finish(timing) {
        const accounting = this.accounting.get(timing.turnId);
        if (accounting?.boundTurn.sessionId === timing.sessionId) {
            this.accounting.delete(timing.turnId);
        }
        const binding = this.bindings.get(timing.turnId);
        if (binding?.sessionId === timing.sessionId)
            this.bindings.delete(timing.turnId);
        const signal = this.signals.get(timing.turnId);
        if (signal?.sessionId === timing.sessionId)
            this.signals.delete(timing.turnId);
        const breaker = this.breakerDecisions.get(timing.turnId);
        if (breaker?.sessionId === timing.sessionId)
            this.breakerDecisions.delete(timing.turnId);
    }
}
//# sourceMappingURL=turn-context.js.map