/** How many recent tool-using Turns of a Goal a new Turn is compared against. */
const RECENT_TOOL_WORK_TURNS = 6;
/** Upper bound on Goals remembered at once; the least recently observed is dropped. */
const MAX_REMEMBERED_GOALS = 256;
/**
 * The tool calls of each Goal's recent Turns, to tell new tool progress from a
 * repeat.
 *
 * A Turn that calls tools usually advances the Goal, but a Goal waiting on
 * something outside the conversation can poll the same unchanged state every
 * Turn and never stop. When every call of a Turn, with the same arguments and
 * the same result, already appeared in one of the Goal's last few tool-using
 * Turns, the Turn made no new tool progress: `repeated` when every call is
 * known read-only, `rerun` when one of them may have changed something.
 *
 * Kept in memory on purpose. After a restart the first Turn simply counts as
 * new progress, which at most delays a no-progress pause by a few Turns.
 */
export class GoalToolWorkHistory {
    turnsByGoal = new Map();
    /**
     * Refine a `used` observation and remember the Turn's calls. Every other
     * activity is returned unchanged, and so is a `used` Turn whose calls the
     * host did not report. Observing the same Turn again (a settlement retry)
     * replaces its entry and never compares it with itself.
     */
    observe(input) {
        const { goalId, turnId, activity, calls } = input;
        if (activity !== 'used' || !calls || calls.length === 0)
            return activity;
        const earlier = (this.turnsByGoal.get(goalId) ?? []).filter((turn) => turn.turnId !== turnId);
        const seen = new Set(earlier.flatMap((turn) => [...turn.fingerprints]));
        this.remember(goalId, [
            ...earlier.slice(-(RECENT_TOOL_WORK_TURNS - 1)),
            { turnId, fingerprints: new Set(calls.map((call) => call.fingerprint)) },
        ]);
        if (!calls.every((call) => seen.has(call.fingerprint)))
            return 'used';
        return calls.every((call) => call.readOnly) ? 'repeated' : 'rerun';
    }
    /** A paused, reset or finished Goal starts its next run with no history. */
    forget(goalId) {
        this.turnsByGoal.delete(goalId);
    }
    remember(goalId, turns) {
        this.turnsByGoal.delete(goalId);
        this.turnsByGoal.set(goalId, turns);
        if (this.turnsByGoal.size <= MAX_REMEMBERED_GOALS)
            return;
        const oldest = this.turnsByGoal.keys().next();
        if (!oldest.done)
            this.turnsByGoal.delete(oldest.value);
    }
}
//# sourceMappingURL=tool-work-history.js.map