import { DesktopWorkspaceFileServiceBase } from './desktop-workspace-file-service.js';
/** Keep published Hook contracts fail closed until the v2 owner is available. */
export class DesktopHookServiceBase extends DesktopWorkspaceFileServiceBase {
    listLocalHooks(..._args) {
        return this.unimplementedGeneratedMethod('listLocalHooks');
    }
    createLocalHook(..._args) {
        return this.unimplementedGeneratedMethod('createLocalHook');
    }
    updateLocalHook(..._args) {
        return this.unimplementedGeneratedMethod('updateLocalHook');
    }
    deleteLocalHook(..._args) {
        return this.unimplementedGeneratedMethod('deleteLocalHook');
    }
    setLocalHookEnabled(..._args) {
        return this.unimplementedGeneratedMethod('setLocalHookEnabled');
    }
    setLocalHookScopeEnabled(..._args) {
        return this.unimplementedGeneratedMethod('setLocalHookScopeEnabled');
    }
}
//# sourceMappingURL=desktop-hook-service-base.js.map