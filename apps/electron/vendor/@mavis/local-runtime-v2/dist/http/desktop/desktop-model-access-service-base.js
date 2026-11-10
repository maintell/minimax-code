import { HTTPException } from 'hono/http-exception';
import { DesktopQuestionnaireServiceBase } from './desktop-questionnaire-service.js';
import { jsonError } from './desktop-service-support.js';
/**
 * Model-access extensions (local packages, capability policy, direct login,
 * subscription borrow, API import and usage)
 * are served only by the v2 controllers. This DesktopService fallback never
 * reads, imports or logs in with user credentials, so every route fails closed
 * with one stable code.
 */
export class DesktopModelAccessServiceBase extends DesktopQuestionnaireServiceBase {
    modelAccessUnsupported() {
        throw new HTTPException(501, {
            res: jsonError(501, 'Model access requires the local-runtime-v2 controller', 'MODEL_ACCESS_UNSUPPORTED_ON_LEGACY_HOST'),
        });
    }
    async listModelAccess() {
        return this.modelAccessUnsupported();
    }
    async previewModelAccessPackage() {
        return this.modelAccessUnsupported();
    }
    async importModelAccessPackage() {
        return this.modelAccessUnsupported();
    }
    async enableModelAccessPackage() {
        return this.modelAccessUnsupported();
    }
    async disableModelAccessPackage() {
        return this.modelAccessUnsupported();
    }
    async rollbackModelAccessPackage() {
        return this.modelAccessUnsupported();
    }
    async uninstallModelAccessPackage() {
        return this.modelAccessUnsupported();
    }
    async startModelAccessDevSession() {
        return this.modelAccessUnsupported();
    }
    async reloadModelAccessDevSession() {
        return this.modelAccessUnsupported();
    }
    async stopModelAccessDevSession() {
        return this.modelAccessUnsupported();
    }
    async promoteModelAccessDevSession() {
        return this.modelAccessUnsupported();
    }
    async getModelAccessExtensionStatus() {
        return this.modelAccessUnsupported();
    }
    async exportModelAccessPackage() {
        return this.modelAccessUnsupported();
    }
    async approveModelAccessDevRequest() {
        return this.modelAccessUnsupported();
    }
    async dismissModelAccessDevRequest() {
        return this.modelAccessUnsupported();
    }
    async syncModelAccessDelivery() {
        return this.modelAccessUnsupported();
    }
    async setModelAccessDeliveryOptIn() {
        return this.modelAccessUnsupported();
    }
    async setModelAccessGlobal() {
        return this.modelAccessUnsupported();
    }
    async setModelAccessTarget() {
        return this.modelAccessUnsupported();
    }
    async beginModelAccessLogin() {
        return this.modelAccessUnsupported();
    }
    async getModelAccessLoginStatus() {
        return this.modelAccessUnsupported();
    }
    async submitModelAccessLogin() {
        return this.modelAccessUnsupported();
    }
    async cancelModelAccessLogin() {
        return this.modelAccessUnsupported();
    }
    async discoverModelAccessBorrow() {
        return this.modelAccessUnsupported();
    }
    async useModelAccessBorrow() {
        return this.modelAccessUnsupported();
    }
    async scanModelAccessApi() {
        return this.modelAccessUnsupported();
    }
    async listModelAccessApiCandidates() {
        return this.modelAccessUnsupported();
    }
    async importModelAccessApi() {
        return this.modelAccessUnsupported();
    }
    async queryModelAccessUsage() {
        return this.modelAccessUnsupported();
    }
    async enableModelAccessPublicProvider() {
        return this.modelAccessUnsupported();
    }
    async disableModelAccessPublicProvider() {
        return this.modelAccessUnsupported();
    }
    async getModelAccessFailover() {
        return this.modelAccessUnsupported();
    }
    async setModelAccessFailover() {
        return this.modelAccessUnsupported();
    }
}
//# sourceMappingURL=desktop-model-access-service-base.js.map