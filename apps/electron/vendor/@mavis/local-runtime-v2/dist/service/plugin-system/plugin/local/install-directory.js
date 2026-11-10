import { isBuiltInPluginMarketplace, isValidPluginMarketplaceName, LOCAL_PLUGIN_MARKETPLACE, OFFICIAL_PLUGIN_MARKETPLACE, } from '@mavis/shared';
import { PluginSystemError } from '../../errors.js';
const MAX_PLUGIN_NAME_LENGTH = 128;
// Path separators, NUL, other C0 controls, and characters Windows rejects in a
// file name never form one portable directory segment.
const UNSAFE_NAME_CHARACTER = /[/\\<>:"|?*\u0000-\u001f\u007f]/u;
/**
 * Identity of an owned root below `${dataDir}/plugins`. A directory named
 * `<name>@<marketplace>` for a user-added marketplace holds that marketplace's
 * entry; every other directory is the LOCAL Plugin named by its manifest.
 */
export function pluginIdFromInstallDirectory(directoryName, manifestName) {
    const at = directoryName.lastIndexOf('@');
    if (at > 0) {
        const name = directoryName.slice(0, at);
        const marketplace = directoryName.slice(at + 1);
        if (isInstallablePluginName(name) &&
            isValidPluginMarketplaceName(marketplace) &&
            !isBuiltInPluginMarketplace(marketplace)) {
            return { name, marketplace };
        }
    }
    return { name: manifestName, marketplace: LOCAL_PLUGIN_MARKETPLACE };
}
/** Directory name below `${dataDir}/plugins`; `local` keeps the historical `<name>` layout. */
export function installDirectoryName(id) {
    return id.marketplace === LOCAL_PLUGIN_MARKETPLACE ? id.name : `${id.name}@${id.marketplace}`;
}
/** A Plugin name usable as one directory segment and as the name part of a PluginId. */
export function isInstallablePluginName(name) {
    return (name.length > 0 &&
        name.length <= MAX_PLUGIN_NAME_LENGTH &&
        // Windows drops trailing dots and spaces, so the directory would not round-trip.
        name === name.trim() &&
        !name.endsWith('.') &&
        !name.includes('@') &&
        !UNSAFE_NAME_CHARACTER.test(name));
}
/** LOCAL acceptance never addresses `official`; other marketplaces must be well-formed. */
export function isInstallablePluginId(id) {
    const marketplaceValid = id.marketplace === LOCAL_PLUGIN_MARKETPLACE ||
        (id.marketplace !== OFFICIAL_PLUGIN_MARKETPLACE &&
            isValidPluginMarketplaceName(id.marketplace));
    return marketplaceValid && isInstallablePluginName(id.name);
}
export function assertInstallablePluginId(id) {
    if (!isInstallablePluginId(id)) {
        throw new PluginSystemError('PLUGIN_ID_INVALID', 'Plugin id cannot be installed locally');
    }
}
//# sourceMappingURL=install-directory.js.map