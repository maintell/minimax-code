import { NotImplementedError } from '../errors.js';
export class BackgroundTaskControllerBase {
    async listBackgroundTasks(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('listBackgroundTasks');
    }
    async getBackgroundTask(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getBackgroundTask');
    }
    async readBackgroundTaskOutput(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('readBackgroundTaskOutput');
    }
    async stopBackgroundTask(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('stopBackgroundTask');
    }
    async deleteBackgroundTask(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('deleteBackgroundTask');
    }
}
//# sourceMappingURL=background-task-controller-base.gen.js.map