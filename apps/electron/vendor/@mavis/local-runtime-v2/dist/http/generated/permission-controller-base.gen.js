import { NotImplementedError } from '../errors.js';
export class PermissionControllerBase {
    async replyPermission(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('replyPermission');
    }
    async replyQuestion(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('replyQuestion');
    }
    async rejectQuestion(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('rejectQuestion');
    }
    async listPendingPermissions(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('listPendingPermissions');
    }
    async dismissPermission(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('dismissPermission');
    }
    async batchReplyPermissions(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('batchReplyPermissions');
    }
}
//# sourceMappingURL=permission-controller-base.gen.js.map