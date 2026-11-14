/**
 * Assigned task state reads the Turn's committed end, which lands after the
 * terminal event, so the state published for that event can still show the
 * admitted Turn. Settlement is the first point where the read is current;
 * the other settlement participants run unchanged after the notice. Only the
 * Turns of coordinator-owned Sessions are noticed: a coordinator's own Session
 * and a task Session; every other Turn settles without entering assignment code.
 */
export function withAssignmentTurnSettlement(assignment, next) {
    return {
        settle: async (input) => {
            try {
                if (await assignment.owns(input.sessionId))
                    assignment.settled(input.sessionId);
            }
            catch {
                // A task-state refresh must not fail the required settlement path.
            }
            await next?.settle(input);
        },
        ...(next?.abandon ? { abandon: next.abandon.bind(next) } : {}),
    };
}
//# sourceMappingURL=assignment-turn-settlement.js.map