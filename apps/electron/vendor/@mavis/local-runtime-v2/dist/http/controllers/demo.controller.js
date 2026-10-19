import { DemoControllerBase } from '../generated/demo-controller-base.gen.js';
import { NotImplementedError } from '../errors.js';
async function* streamEchoFrames(message, repeatToken) {
    yield { event: 'message_delta', messageDelta: message };
    if (repeatToken)
        yield { event: 'repeat_token', messageDelta: repeatToken };
    yield { event: 'done', done: 'true' };
}
class DemoController extends DemoControllerBase {
    async ping(ctx, req) {
        void ctx;
        return { message: `pong: ${req.message}` };
    }
    async getEcho(ctx, req) {
        void ctx;
        const suffix = req.suffix ? ` ${req.suffix}` : '';
        return { message: `get: ${req.message}${suffix}` };
    }
    async getHeaderEcho(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getHeaderEcho');
    }
    async getPathEcho(ctx, req) {
        void ctx;
        const suffix = req.suffix ? ` ${req.suffix}` : '';
        return { message: `path(${req.resourceId})${suffix}` };
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
        const message = req.message.trim();
        if (message.length === 0) {
            return {
                ok: false,
                status: 400,
                body: { code: 'invalid_message', message: 'message is required' },
            };
        }
        return { ok: true, source: streamEchoFrames(message, req.repeatToken) };
    }
}
export const demoController = new DemoController();
//# sourceMappingURL=demo.controller.js.map