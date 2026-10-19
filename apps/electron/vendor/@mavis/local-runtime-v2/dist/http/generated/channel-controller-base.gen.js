import { NotImplementedError } from '../errors.js';
export class ChannelControllerBase {
    async listChannelBindings(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('listChannelBindings');
    }
    async listChannelConnections(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('listChannelConnections');
    }
    async prepareChannelConnection(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('prepareChannelConnection');
    }
    async disconnectChannelConnection(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('disconnectChannelConnection');
    }
    async deleteChannelConnection(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('deleteChannelConnection');
    }
    async cancelChannelAuthorization(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('cancelChannelAuthorization');
    }
    async unbindChannel(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('unbindChannel');
    }
    async updateChannelBindingTarget(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('updateChannelBindingTarget');
    }
    async bindTelegram(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('bindTelegram');
    }
    async startWechatBind(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('startWechatBind');
    }
    async getWechatBindStatus(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getWechatBindStatus');
    }
    async bindFeishu(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('bindFeishu');
    }
    async startLarkOnboard(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('startLarkOnboard');
    }
    async getLarkOnboardStatus(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getLarkOnboardStatus');
    }
    async cancelLarkOnboard(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('cancelLarkOnboard');
    }
}
//# sourceMappingURL=channel-controller-base.gen.js.map