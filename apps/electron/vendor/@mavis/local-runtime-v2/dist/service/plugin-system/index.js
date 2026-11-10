export { initializePluginService } from './initialize.js';
export { settleInBackground } from './plugin-system-helpers.js';
export { SkillEnabledState } from './skill/enabled-state.js';
export { PluginSystemCloudTransport, PluginSystemCloudTransportError } from './cloud-transport.js';
// Same deterministic-ZIP and sha256-tree-v1 contract, reused by official model access delivery.
export { materializeOfficialPluginArchive } from './plugin/package/archive-cache.js';
export { computePluginDirectoryDigest } from './plugin/package/package-contract.js';
export { PluginSystemError } from './errors.js';
export { PluginDesktopFacadeError } from './plugin/runtime/desktop-facade.js';
export { createPluginNameReservations, resolvePluginCloudBaseUrl } from './initialize.js';
export { initializePluginHookPermissions } from './hook-permissions/initialize.js';
//# sourceMappingURL=index.js.map