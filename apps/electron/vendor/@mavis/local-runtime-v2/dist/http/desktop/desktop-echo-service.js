import { streamEchoFrames } from './desktop-service-support.js';
export class DesktopEchoService {
    ping(ctx, req) {
        void ctx;
        return Promise.resolve({ message: `pong: ${req.message}` });
    }
    getEcho(ctx, req) {
        void ctx;
        const suffix = req.suffix ? ` ${req.suffix}` : '';
        return Promise.resolve({ message: `get: ${req.message}${suffix}` });
    }
    getHeaderEcho(ctx, req) {
        void ctx;
        return Promise.resolve({ message: `header(${req.clientName}): ${req.message}` });
    }
    getPathEcho(ctx, req) {
        void ctx;
        const suffix = req.suffix ? ` ${req.suffix}` : '';
        return Promise.resolve({ message: `path(${req.resourceId})${suffix}` });
    }
    getQueryBindingEcho(ctx, req) {
        void ctx;
        return Promise.resolve({ message: JSON.stringify(req) });
    }
    getNestedQueryBindingEcho(ctx, req) {
        void ctx;
        return Promise.resolve({ label: req.label, nested: req.nested });
    }
    submitFieldEcho(ctx, req) {
        void ctx;
        const detail = req.detail ? `/${req.detail}` : '';
        return Promise.resolve({ message: `field(${req.clientName}): ${req.title}${detail}` });
    }
    submitNestedFieldEcho(ctx, req) {
        void ctx;
        return Promise.resolve({
            message: `nested-field(${req.clientName}): ${req.title}`,
            nested: req.nested,
        });
    }
    streamEcho(ctx, req) {
        void ctx;
        const message = req.message.trim();
        if (message.length === 0) {
            return Promise.resolve({
                ok: false,
                status: 400,
                body: { code: 'invalid_message', message: 'message is required' },
            });
        }
        return Promise.resolve({ ok: true, source: streamEchoFrames(message, req.repeatToken) });
    }
}
//# sourceMappingURL=desktop-echo-service.js.map