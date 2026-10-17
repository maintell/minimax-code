export const PLUGIN_HOOK_PERMISSION_STORE_VERSION = 1;
export class LocalPluginHookPermissionMutationError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = 'LocalPluginHookPermissionMutationError';
    }
}
//# sourceMappingURL=plugin-hook-permission-contracts.js.map