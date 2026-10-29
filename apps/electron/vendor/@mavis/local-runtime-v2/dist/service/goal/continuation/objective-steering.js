import { createHash } from 'node:crypto';
export class ObjectiveSteeringTargetChangedError extends Error {
    constructor() {
        super('Thread Goal objective steering target changed before delivery.');
        this.name = 'ObjectiveSteeringTargetChangedError';
    }
}
export function objectiveUpdateSteeringKey(goal) {
    const digest = createHash('sha256').update(goal.objective).digest('hex').slice(0, 16);
    return `thread-goal-objective:${goal.goalId}:${goal.updatedAt}:${digest}`;
}
//# sourceMappingURL=objective-steering.js.map