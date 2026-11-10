import { NotImplementedError } from '../errors.js';
export class GoalControllerBase {
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
    async dismissGoal(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('dismissGoal');
    }
    async deleteGoal(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('deleteGoal');
    }
}
//# sourceMappingURL=goal-controller-base.gen.js.map