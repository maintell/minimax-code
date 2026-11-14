import { DesktopMiniAppServiceBase } from './desktop-miniapp-service-base.js';
/** Website methods stay unavailable until their owning Runtime implementation is bound. */
export class DesktopWebsiteServiceBase extends DesktopMiniAppServiceBase {
    // Website management is contract-first in the current IDL. Legacy hosts
    // keep the routes explicit and fail-closed until the owning implementation lands.
    listDeployedWebsites(..._args) {
        return this.unimplementedGeneratedMethod('ListDeployedWebsites');
    }
    getWebsiteTrafficStats(..._args) {
        return this.unimplementedGeneratedMethod('GetWebsiteTrafficStats');
    }
    getWebsiteState(..._args) {
        return this.unimplementedGeneratedMethod('GetWebsiteState');
    }
    cancelWebsiteDeployment(..._args) {
        return this.unimplementedGeneratedMethod('CancelWebsiteDeployment');
    }
    unpublishWebsiteDeployment(..._args) {
        return this.unimplementedGeneratedMethod('UnpublishWebsiteDeployment');
    }
    republishWebsiteDeployment(..._args) {
        return this.unimplementedGeneratedMethod('RepublishWebsiteDeployment');
    }
    updateWebsiteWatermark(..._args) {
        return this.unimplementedGeneratedMethod('UpdateWebsiteWatermark');
    }
    updateWebsiteDisplayName(..._args) {
        return this.unimplementedGeneratedMethod('UpdateWebsiteDisplayName');
    }
    setWebsiteAlias(..._args) {
        return this.unimplementedGeneratedMethod('SetWebsiteAlias');
    }
    checkWebsiteAliasAvailability(..._args) {
        return this.unimplementedGeneratedMethod('CheckWebsiteAliasAvailability');
    }
    unbindWebsiteAlias(..._args) {
        return this.unimplementedGeneratedMethod('UnbindWebsiteAlias');
    }
    removeWebsiteAlias(..._args) {
        return this.unimplementedGeneratedMethod('RemoveWebsiteAlias');
    }
    getWebsiteProjectSourceDownloadURL(..._args) {
        return this.unimplementedGeneratedMethod('GetWebsiteProjectSourceDownloadURL');
    }
}
//# sourceMappingURL=desktop-website-service-base.js.map