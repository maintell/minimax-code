import { NotImplementedError } from '../errors.js';
export class PinControllerBase {
    async pinAgent(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('pinAgent');
    }
    async pinSession(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('pinSession');
    }
    async getPinnedItemsOrder(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getPinnedItemsOrder');
    }
    async putPinnedItemsOrder(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('putPinnedItemsOrder');
    }
}
//# sourceMappingURL=pin-controller-base.gen.js.map