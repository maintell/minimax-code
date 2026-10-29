import { BackgroundTaskControllerBase } from '../generated/background-task-controller-base.gen.js';
import { NotImplementedError } from '../errors.js';
export class BackgroundTaskController extends BackgroundTaskControllerBase {
    applications;
    constructor(applications) {
        super();
        this.applications = applications;
    }
    async listBackgroundTasks(ctx, req) {
        if (!this.applications)
            throw new NotImplementedError('listBackgroundTasks');
        return this.applications.backgroundTask.listBackgroundTasks(ctx, req);
    }
    async getBackgroundTask(ctx, req) {
        if (!this.applications)
            throw new NotImplementedError('getBackgroundTask');
        return this.applications.backgroundTask.getBackgroundTask(ctx, req);
    }
    async readBackgroundTaskOutput(ctx, req) {
        if (!this.applications)
            throw new NotImplementedError('readBackgroundTaskOutput');
        return this.applications.backgroundTask.readBackgroundTaskOutput(ctx, req);
    }
    async stopBackgroundTask(ctx, req) {
        if (!this.applications)
            throw new NotImplementedError('stopBackgroundTask');
        return this.applications.backgroundTask.stopBackgroundTask(ctx, req);
    }
    async deleteBackgroundTask(ctx, req) {
        if (!this.applications)
            throw new NotImplementedError('deleteBackgroundTask');
        return this.applications.backgroundTask.deleteBackgroundTask(ctx, req);
    }
}
//# sourceMappingURL=background-task.controller.js.map