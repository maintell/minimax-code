import { NotImplementedError } from '../errors.js';
export class CronControllerBase {
    async listCrons(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('listCrons');
    }
    async listCronSessions(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('listCronSessions');
    }
    async createCron(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('createCron');
    }
    async triggerCron(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('triggerCron');
    }
    async updateCron(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('updateCron');
    }
    async deleteCron(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('deleteCron');
    }
    async listCronDefinitions(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('listCronDefinitions');
    }
    async getCronDefinition(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getCronDefinition');
    }
    async createCronDefinition(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('createCronDefinition');
    }
    async updateCronDefinition(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('updateCronDefinition');
    }
    async deleteCronDefinition(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('deleteCronDefinition');
    }
    async triggerCronRun(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('triggerCronRun');
    }
    async listCronRuns(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('listCronRuns');
    }
}
//# sourceMappingURL=cron-controller-base.gen.js.map