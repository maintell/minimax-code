import { AppError } from '../errors.js';
import { ModelAccessControllerBase } from '../generated/model-access-controller-base.gen.js';
import { toProviderInfo } from './model-provider-mappers.js';
/** Protocol adapter only: validation, orchestration and error mapping live in the Application. */
export class ModelAccessController extends ModelAccessControllerBase {
    application;
    constructor(application) {
        super();
        this.application = application;
    }
    async listModelAccess(_ctx, _req) {
        return { snapshot: await this.require().snapshot() };
    }
    async previewModelAccessPackage(_ctx, req) {
        return this.require().preview(req.source, req.sourceRef);
    }
    async importModelAccessPackage(_ctx, req) {
        return { snapshot: await this.require().importPackage(req) };
    }
    async enableModelAccessPackage(_ctx, req) {
        return { snapshot: await this.require().enable(req.installationId) };
    }
    async disableModelAccessPackage(_ctx, req) {
        return { snapshot: await this.require().disable(req.installationId) };
    }
    async rollbackModelAccessPackage(_ctx, req) {
        return { snapshot: await this.require().rollback(req) };
    }
    async startModelAccessDevSession(_ctx, req) {
        return this.require().userPackages.startDev(req);
    }
    async approveModelAccessDevRequest(_ctx, req) {
        return this.require().userPackages.approveRequest(req);
    }
    async dismissModelAccessDevRequest(_ctx, req) {
        return { snapshot: await this.require().userPackages.dismissRequest(req.requestId) };
    }
    async reloadModelAccessDevSession(_ctx, req) {
        return this.require().userPackages.reloadDev(req.sessionId);
    }
    async stopModelAccessDevSession(_ctx, req) {
        return { snapshot: await this.require().userPackages.stopDev(req.sessionId) };
    }
    async promoteModelAccessDevSession(_ctx, req) {
        return { snapshot: await this.require().userPackages.promote(req) };
    }
    async getModelAccessExtensionStatus(_ctx, req) {
        return this.require().userPackages.status(req.installationId);
    }
    async exportModelAccessPackage(_ctx, req) {
        return this.require().userPackages.exportPackage(req);
    }
    async uninstallModelAccessPackage(_ctx, req) {
        return { snapshot: await this.require().uninstall(req.installationId) };
    }
    async syncModelAccessDelivery(_ctx, _req) {
        return { snapshot: await this.require().syncDelivery() };
    }
    async setModelAccessDeliveryOptIn(_ctx, req) {
        return { snapshot: await this.require().setDeliveryOptIn(req.enabled) };
    }
    async setModelAccessGlobal(_ctx, req) {
        return { snapshot: await this.require().setGlobal(req) };
    }
    async setModelAccessTarget(_ctx, req) {
        return { snapshot: await this.require().setTarget(req) };
    }
    async beginModelAccessLogin(_ctx, req) {
        return toLoginResp(await this.require().beginLogin(req));
    }
    async getModelAccessLoginStatus(_ctx, req) {
        return toLoginResp(await this.require().loginStatus(req.flowId));
    }
    async submitModelAccessLogin(_ctx, req) {
        return toLoginResp(await this.require().submitLogin(req));
    }
    async cancelModelAccessLogin(_ctx, req) {
        return toLoginResp(await this.require().cancelLogin(req.flowId));
    }
    async discoverModelAccessBorrow(ctx, req) {
        return { candidates: await this.require().discoverBorrow(req, ctx.signal) };
    }
    async useModelAccessBorrow(ctx, req) {
        return { provider: toProviderInfo(await this.require().useBorrow(req, ctx.signal)) };
    }
    async scanModelAccessApi(ctx, req) {
        return this.require().scanApi(req, ctx.signal);
    }
    async listModelAccessApiCandidates(_ctx, _req) {
        return this.require().listApiCandidates();
    }
    async importModelAccessApi(ctx, req) {
        return this.require().importApi(req.candidateIds, ctx.signal);
    }
    async enableModelAccessPublicProvider(ctx, req) {
        return { provider: toProviderInfo(await this.require().enablePublic(req, ctx.signal)) };
    }
    async disableModelAccessPublicProvider(_ctx, req) {
        return { removed: await this.require().disablePublic(req) };
    }
    async queryModelAccessUsage(ctx, req) {
        return { usage: await this.require().queryUsage(req.providerId, ctx.signal) };
    }
    async getModelAccessFailover(_ctx, req) {
        return this.require().getFailover(requireProviderId(req.providerId));
    }
    async setModelAccessFailover(_ctx, req) {
        const providerId = requireProviderId(req.providerId);
        if (!Array.isArray(req.backups) || !req.backups.every((item) => typeof item === 'string')) {
            throw new AppError(400, 'VALIDATION_ERROR', 'backups must be a list of provider ids');
        }
        if (req.members !== undefined &&
            (!Array.isArray(req.members) || !req.members.every((item) => typeof item === 'string'))) {
            throw new AppError(400, 'VALIDATION_ERROR', 'members must be a list of provider ids');
        }
        return this.require().setFailover({
            providerId,
            enabled: req.enabled,
            backups: req.backups,
            ...(req.members !== undefined ? { members: req.members } : {}),
        });
    }
    require() {
        if (!this.application) {
            throw new AppError(503, 'MODEL_ACCESS_UNAVAILABLE', 'Model access is not available on this runtime host');
        }
        return this.application;
    }
}
function requireProviderId(value) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new AppError(400, 'VALIDATION_ERROR', 'provider_id is required');
    }
    return value;
}
function toLoginResp(result) {
    return {
        login: {
            ...result.login,
            ...(result.provider ? { provider: toProviderInfo(result.provider) } : {}),
        },
    };
}
//# sourceMappingURL=model-access.controller.js.map