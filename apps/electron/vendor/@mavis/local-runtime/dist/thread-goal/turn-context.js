/** Owns all per-Turn Goal bindings, accounting receipts, and model proposals. */
export class GoalTurnContextRegistry {
    bindings = new Map();
    accounting = new Map();
    signals = new Map();
    breakerDecisions = new Map();
    getBinding(turnId) {
        return this.bindings.get(turnId);
    }
    setBinding(turnId, binding) {
        this.bindings.set(turnId, binding);
    }
    deleteBinding(turnId) {
        this.bindings.delete(turnId);
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