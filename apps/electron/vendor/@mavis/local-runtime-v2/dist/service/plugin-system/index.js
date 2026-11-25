export { initializePluginService } from './initialize.js';
export { normalizedPluginName, settleInBackground } from './plugin-system-helpers.js';
export { SkillEnabledState } from './skill/enabled-state.js';
export { PluginSystemCloudTransport, PluginSystemCloudTransportError } from './cloud-transport.js';
// Same deterministic-ZIP and sha256-tree-v1 contract, reused by official model access delivery.
export { materializeOfficialPluginArchive } from './plugin/package/archive-cache.js';
export { PluginSystemError } from './errors.js';
export { PluginDesktopFacadeError } from './plugin/runtime/desktop-facade.js';
export { createPluginNameReservations, resolvePluginCloudBaseUrl } from './initialize.js';
export { initializePluginHookPermissions } from './hook-permissions/initialize.js';
// computePluginDirectoryDigest is the sha256-tree-v1 contract model access delivery also reuses.
export { computePluginDirectoryDigest, materializeContentAddressedDirectory, PluginPackageContractError, } from './plugin/package/package-contract.js';
export { isMiniMaxPluginName } from './plugin/package/minimax-reader.js';
export { readExtensionCandidatePackage } from './plugin/package/package-readers.js';
//# sourceMappingURL=index.js.map