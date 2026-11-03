import { createHash } from 'node:crypto';
/**
 * The objective steer's pre-delivery withdrawal: its observed Turn or gates
 * changed before delivery, and the Goal continuation takes the edit instead.
 * Named `AbortError` so a withdrawn activation is projected as a cancelled
 * pre-host Turn rather than a Session `turn-system` failure (WN5G6FPQ).
 */
export class ObjectiveSteeringTargetChangedError extends Error {
    name = 'AbortError';
    constructor() {
        super('Thread Goal objective steering target changed before delivery.');
    }
}
export function objectiveUpdateSteeringKey(goal) {
    const digest = createHash('sha256').update(goal.objective).digest('hex').slice(0, 16);
    return `thread-goal-objective:${goal.goalId}:${goal.updatedAt}:${digest}`;
}
//# sourceMappingURL=objective-steering.js.map