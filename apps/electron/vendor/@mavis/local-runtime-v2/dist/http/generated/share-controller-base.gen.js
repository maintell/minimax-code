import { NotImplementedError } from '../errors.js';
export class ShareControllerBase {
    async packShareWork(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('packShareWork');
    }
    async publishShareWork(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('publishShareWork');
    }
    async prepareSharedInstall(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('prepareSharedInstall');
    }
    async commitSharedInstall(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('commitSharedInstall');
    }
    async discardSharedInstall(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('discardSharedInstall');
    }
    async listShareInstallations(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('listShareInstallations');
    }
}
//# sourceMappingURL=share-controller-base.gen.js.map