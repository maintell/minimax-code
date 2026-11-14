import { MiniAppLaunchpadControllerBase } from '../generated/mini-app-launchpad-controller-base.gen.js';
export class MiniAppLaunchpadController extends MiniAppLaunchpadControllerBase {
    application;
    constructor(application) {
        super();
        this.application = application;
    }
    async ensureMiniAppHostSession(ctx, req) {
        return this.application && ctx.requestHeaders.get('X-MCode-Request-Source') !== 'remote-control'
            ? this.application.ensureMiniAppHostSession(req)
            : { ok: false, code: 'unavailable' };
    }
    async suggestMiniAppCreationIdeas(ctx, req) {
        return this.application && ctx.requestHeaders.get('X-MCode-Request-Source') !== 'remote-control'
            ? this.application.suggestMiniAppCreationIdeas(req)
            : { ok: false, code: 'unavailable' };
    }
    async startMiniAppCreation(ctx, req) {
        return this.application && ctx.requestHeaders.get('X-MCode-Request-Source') !== 'remote-control'
            ? this.application.startMiniAppCreation(req)
            : { ok: false, code: 'unavailable' };
    }
    async stopMiniAppCreation(ctx, req) {
        return this.application && ctx.requestHeaders.get('X-MCode-Request-Source') !== 'remote-control'
            ? this.application.stopMiniAppCreation(req)
            : { ok: false, code: 'unavailable' };
    }
    async removeMiniAppCreation(ctx, req) {
        return this.application && ctx.requestHeaders.get('X-MCode-Request-Source') !== 'remote-control'
            ? this.application.removeMiniAppCreation(req)
            : { ok: false, code: 'unavailable' };
    }
    async maintainMiniAppCreation(ctx, req) {
        return this.application && ctx.requestHeaders.get('X-MCode-Request-Source') !== 'remote-control'
            ? this.application.maintainMiniAppCreation(req)
            : { ok: false, code: 'unavailable' };
    }
    async getMiniAppCreation(ctx, req) {
        return this.application && ctx.requestHeaders.get('X-MCode-Request-Source') !== 'remote-control'
            ? this.application.getMiniAppCreation(req)
            : { ok: false, code: 'unavailable' };
    }
    async listMiniAppLaunchpad(ctx, req) {
        return this.application && ctx.requestHeaders.get('X-MCode-Request-Source') !== 'remote-control'
            ? this.application.listMiniAppLaunchpad(req)
            : { ok: false, code: 'unavailable' };
    }
}
//# sourceMappingURL=mini-app-launchpad.controller.js.map