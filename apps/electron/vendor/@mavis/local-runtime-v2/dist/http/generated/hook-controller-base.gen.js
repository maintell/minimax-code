import { NotImplementedError } from '../errors.js';
export class HookControllerBase {
    async listLocalHooks(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('listLocalHooks');
    }
    async createLocalHook(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('createLocalHook');
    }
    async updateLocalHook(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('updateLocalHook');
    }
    async deleteLocalHook(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('deleteLocalHook');
    }
    async setLocalHookEnabled(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('setLocalHookEnabled');
    }
    async setLocalHookScopeEnabled(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('setLocalHookScopeEnabled');
    }
}
//# sourceMappingURL=hook-controller-base.gen.js.map