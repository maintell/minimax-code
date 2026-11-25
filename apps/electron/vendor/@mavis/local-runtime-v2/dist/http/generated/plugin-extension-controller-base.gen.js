import { NotImplementedError } from '../errors.js';
export class PluginExtensionControllerBase {
    async listExtensionEntries(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('listExtensionEntries');
    }
    async renderExtension(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('renderExtension');
    }
    async pressExtension(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('pressExtension');
    }
    async inputExtension(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('inputExtension');
    }
    async selectExtension(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('selectExtension');
    }
    async ackExtensionApplied(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('ackExtensionApplied');
    }
    async reportExtensionFallback(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('reportExtensionFallback');
    }
    async answerExtensionQuery(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('answerExtensionQuery');
    }
    async closeExtensionPane(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('closeExtensionPane');
    }
    async subscribeExtensionStream(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('subscribeExtensionStream');
    }
}
//# sourceMappingURL=plugin-extension-controller-base.gen.js.map