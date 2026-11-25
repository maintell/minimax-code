import { LOCAL_PLUGIN_MARKETPLACE, pluginIdKey } from '@mavis/shared';
import { PluginSystemError } from '../../errors.js';
import { normalizedPluginName } from '../../plugin-system-helpers.js';
/**
 * Admission for a Host-authored `<name>@local` Plugin (Mini App workspace
 * publication). An installed official Plugin of the same name stays read-only
 * for this path. Local conflicts are by PluginId: a same-name Plugin from a
 * user-added marketplace does not block, and the snapshot decides which copy
 * is effective.
 */
export class PluginNameReservation {
    source;
    constructor(source) {
        this.source = source;
    }
    async assertAvailable(pluginName, options = {}) {
        if (await this.isOfficialName(pluginName)) {
            throw alreadyInstalled(options.allowEnabledMiniAppUpdate ? 'OFFICIAL_PLUGIN_READ_ONLY' : undefined);
        }
        const key = pluginIdKey({ name: pluginName, marketplace: LOCAL_PLUGIN_MARKETPLACE });
        const localOwners = (await this.source.readLocalPackages()).filter((entry) => pluginIdKey(entry.id ?? { name: entry.plugin.name, marketplace: LOCAL_PLUGIN_MARKETPLACE }) === key);
        if (localOwners.length === 0)
            return;
        const current = localOwners[0];
        if (localOwners.length === 1 &&
            options.allowEnabledMiniAppUpdate &&
            current?.plugin.miniapp !== undefined) {
            if (!this.source.isLocalEnabled(current.plugin.rootPath)) {
                throw new PluginSystemError('PLUGIN_NOT_ENABLED', 'Mini App Plugin is disabled');
            }
            return;
        }
        throw alreadyInstalled();
    }
    /**
     * A `LOCAL_PREVIEW` extension is a per-session overlay and an installed extension is a LOCAL
     * Plugin: either may share the name of an installed local Plugin, never that of an installed
     * official one.
     */
    async assertPreviewAvailable(pluginName) {
        if (await this.isOfficialName(pluginName)) {
            throw new PluginSystemError('EXTENSION_NAME_RESERVED', 'An extension cannot replace an installed official Plugin');
        }
    }
    async isOfficialName(pluginName) {
        const nameKey = normalizedPluginName(pluginName);
        return (await this.source.readOfficialInstallations()).some((installation) => installation.installed && normalizedPluginName(installation.name) === nameKey);
    }
}
function alreadyInstalled(reasonCode) {
    return new PluginSystemError('PLUGIN_ALREADY_EXISTS', 'Plugin name is already installed', {
        ...(reasonCode ? { reasonCode } : {}),
    });
}
//# sourceMappingURL=plugin-name-reservation.js.map