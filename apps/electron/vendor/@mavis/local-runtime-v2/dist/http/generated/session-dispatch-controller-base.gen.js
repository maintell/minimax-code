import { NotImplementedError } from '../errors.js';
export class SessionDispatchControllerBase {
    async approveLocalSessionHandoff(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('approveLocalSessionHandoff');
    }
    async getLocalSessionHandoffEligibility(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getLocalSessionHandoffEligibility');
    }
    async getSessionHandoffSummary(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getSessionHandoffSummary');
    }
    async downloadSessionResult(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('downloadSessionResult');
    }
    async overwriteSessionResult(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('overwriteSessionResult');
    }
}
//# sourceMappingURL=session-dispatch-controller-base.gen.js.map