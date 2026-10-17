import { PermissionControllerBase } from '../generated/permission-controller-base.gen.js';
import { NotImplementedError } from '../errors.js';
class PermissionController extends PermissionControllerBase {
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
export const permissionController = new PermissionController();
//# sourceMappingURL=permission.controller.js.map