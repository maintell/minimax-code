import { GoalControllerBase } from '../generated/goal-controller-base.gen.js';
import { AppError } from '../errors.js';
/** Delegates the DesktopService Goal routes to the single Goal owner. */
export class GoalController extends GoalControllerBase {
    application;
    constructor(application) {
        super();
        this.application = application;
    }
    async createGoal(ctx, req) {
        void ctx;
        return this.requireApplication('createGoal').createGoal(req);
    }
    async getGoal(ctx, req) {
        void ctx;
        return this.requireApplication('getGoal').getGoal(req);
    }
    async patchGoal(ctx, req) {
        void ctx;
        return this.requireApplication('patchGoal').patchGoal(req);
    }
    async deleteGoal(ctx, req) {
        void ctx;
        return this.requireApplication('deleteGoal').deleteGoal(req);
    }
    async dismissGoal(ctx, req) {
        void ctx;
        return this.requireApplication('dismissGoal').dismissGoal(req);
    }
    /**
     * A runtime composed without the Goal owner (no `services.goal`) answers the
     * same way v1 did: the capability is unavailable, not unimplemented.
     */
    requireApplication(method) {
        if (!this.application) {
            throw new AppError(503, 'GOAL_UNAVAILABLE', `${method}: Thread Goal is unavailable`, true);
        }
        return this.application;
    }
}
export const goalController = new GoalController();
//# sourceMappingURL=goal.controller.js.map