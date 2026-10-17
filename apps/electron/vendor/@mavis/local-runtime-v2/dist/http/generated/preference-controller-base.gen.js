import { NotImplementedError } from '../errors.js';
export class PreferenceControllerBase {
    async getGlobalInstructions(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getGlobalInstructions');
    }
    async putGlobalInstructions(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('putGlobalInstructions');
    }
    async getWorkspaceIndexingPreference(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getWorkspaceIndexingPreference');
    }
    async putWorkspaceIndexingPreference(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('putWorkspaceIndexingPreference');
    }
    async getComposerSendBehavior(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getComposerSendBehavior');
    }
    async putComposerSendBehavior(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('putComposerSendBehavior');
    }
    async getComposerEnterBehavior(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getComposerEnterBehavior');
    }
    async putComposerEnterBehavior(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('putComposerEnterBehavior');
    }
}
//# sourceMappingURL=preference-controller-base.gen.js.map