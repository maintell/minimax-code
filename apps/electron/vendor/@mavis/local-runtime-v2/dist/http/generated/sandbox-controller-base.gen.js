import { NotImplementedError } from '../errors.js';
export class SandboxControllerBase {
    async getSandboxStatus(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getSandboxStatus');
    }
    async putSandboxConfig(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('putSandboxConfig');
    }
    async getSandboxViolations(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getSandboxViolations');
    }
}
//# sourceMappingURL=sandbox-controller-base.gen.js.map