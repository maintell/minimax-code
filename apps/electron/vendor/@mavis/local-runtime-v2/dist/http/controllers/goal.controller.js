import { GoalControllerBase } from '../generated/goal-controller-base.gen.js';
import { NotImplementedError } from '../errors.js';
class GoalController extends GoalControllerBase {
    async createGoal(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('createGoal');
    }
    async getGoal(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getGoal');
    }
    async patchGoal(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('patchGoal');
    }
    async deleteGoal(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('deleteGoal');
    }
    async dismissGoal(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('dismissGoal');
    }
}
export const goalController = new GoalController();
//# sourceMappingURL=goal.controller.js.map