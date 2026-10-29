/**
 * Upper bound on remembered Turns per Goal. A Goal that runs longer only
 * forgets its oldest Turns, whose background work has long since settled.
 */
const MAX_TURNS_PER_GOAL = 1_024;
/**
 * Which Turns each Goal actually ran, for the lifetime of this process.
 *
 * A Turn binding lives only until its Turn finishes, but two decisions need to
 * know about a Goal Turn after that:
 *
 *   - Did a resume really start a Goal Turn? The Turn may already have run and
 *     failed by the time the entry point reads the result back.
 *   - Which background tasks are this Goal's dependencies? Only work a Goal Turn
 *     started may hold the Goal, and that work outlives the Turn.
 *
 * Kept in memory on purpose: background work does not survive a restart (the
 * task runtime marks it lost), so a process never needs Turns it did not run.
 */
export class GoalTurnHistory {
    turnsByGoal = new Map();
    /** Record a Turn the moment its Goal binding commits. */
    record(goalId, turnId) {
        let turns = this.turnsByGoal.get(goalId);
        if (!turns) {
            turns = new Set();
            this.turnsByGoal.set(goalId, turns);
        }
        turns.add(turnId);
        if (turns.size <= MAX_TURNS_PER_GOAL)
            return;
        const oldest = turns.values().next();
        if (!oldest.done)
            turns.delete(oldest.value);
    }
    has(goalId, turnId) {
        return this.turnsByGoal.get(goalId)?.has(turnId) === true;
    }
    /** A deleted or finished Goal owns no further work. */
    forget(goalId) {
        this.turnsByGoal.delete(goalId);
    }
}
//# sourceMappingURL=goal-turn-history.js.map