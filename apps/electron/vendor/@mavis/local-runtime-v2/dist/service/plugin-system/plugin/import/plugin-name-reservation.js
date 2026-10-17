import { PluginSystemError } from '../../errors.js';
import { normalizedPluginName } from '../../plugin-system-helpers.js';
/** Applies one authoritative installed-name policy to every local Plugin acceptance path. */
export class PluginNameReservation {
    source;
    constructor(source) {
        this.source = source;
    }
    async assertAvailable(pluginName, options = {}) {
        const key = normalizedPluginName(pluginName);
        const officialInstallations = await this.source.readOfficialInstallations();
        if (officialInstallations.some((installation) => installation.installed && normalizedPluginName(installation.name) === key)) {
            throw alreadyInstalled(options.allowEnabledMiniAppUpdate ? 'OFFICIAL_PLUGIN_READ_ONLY' : undefined);
        }
        const localOwners = (await this.source.readLocalPackages()).filter(({ plugin }) => normalizedPluginName(plugin.name) === key);
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
}
function alreadyInstalled(reasonCode) {
    return new PluginSystemError('PLUGIN_ALREADY_EXISTS', 'Plugin name is already installed', {
        ...(reasonCode ? { reasonCode } : {}),
    });
}
//# sourceMappingURL=plugin-name-reservation.js.map