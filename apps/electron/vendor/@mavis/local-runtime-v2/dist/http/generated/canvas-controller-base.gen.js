import { NotImplementedError } from '../errors.js';
export class CanvasControllerBase {
    async readCanvas(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('readCanvas');
    }
    async prepareCanvasFiles(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('prepareCanvasFiles');
    }
    async applyCanvasOperation(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('applyCanvasOperation');
    }
    async removeCanvasImageBackground(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('removeCanvasImageBackground');
    }
    async enhanceCanvasImage(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('enhanceCanvasImage');
    }
}
//# sourceMappingURL=canvas-controller-base.gen.js.map