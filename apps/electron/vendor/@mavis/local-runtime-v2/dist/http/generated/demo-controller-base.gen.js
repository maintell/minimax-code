import { NotImplementedError } from '../errors.js';
export class DemoControllerBase {
    async ping(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('ping');
    }
    async getEcho(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getEcho');
    }
    async getHeaderEcho(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getHeaderEcho');
    }
    async getPathEcho(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getPathEcho');
    }
    async getQueryBindingEcho(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getQueryBindingEcho');
    }
    async getNestedQueryBindingEcho(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getNestedQueryBindingEcho');
    }
    async submitFieldEcho(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('submitFieldEcho');
    }
    async submitNestedFieldEcho(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('submitNestedFieldEcho');
    }
    async streamEcho(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('streamEcho');
    }
}
//# sourceMappingURL=demo-controller-base.gen.js.map