import { DesktopAgentToolError, mapToolError } from '../sidebar-tools/index.js';
/**
 * Backs the `app` plugin tools. Plugin state is the Runtime's own, so these
 * need no UI round trip; each one calls the same plugin owner the settings
 * page uses.
 */
/** The settings page pages at 100; one tool call reads the same window. */
const PLUGIN_PAGE_LIMIT = 100;
export class DesktopAppToolsService {
    options;
    constructor(options) {
        this.options = options;
    }
    async listPlugins() {
        try {
            const page = await this.options.applications.plugins.listInstalledPlugins({
                limit: PLUGIN_PAGE_LIMIT,
            });
            return { plugins: (page.plugins ?? []).map(toPluginSummary) };
        }
        catch (error) {
            throw mapToolError(error, 'Failed to list the plugins.');
        }
    }
    async setPluginEnabled(req) {
        try {
            const mutate = req.enabled
                ? this.options.applications.plugins.enablePlugin
                : this.options.applications.plugins.disablePlugin;
            const result = await mutate.call(this.options.applications.plugins, {
                pluginName: req.name,
            });
            return { name: req.name, enabled: result.enabled === true };
        }
        catch (error) {
            throw mapToolError(error, `Failed to ${req.enabled ? 'enable' : 'disable'} the plugin.`);
        }
    }
    async uninstallPlugin(req) {
        try {
            const result = await this.options.applications.plugins.uninstallPlugin({
                pluginName: req.name,
            });
            if (result.installExists === true) {
                throw new DesktopAgentToolError('INTERNAL', `The plugin ${req.name} is still installed after the uninstall.`);
            }
            return { name: req.name, uninstalled: true };
        }
        catch (error) {
            throw mapToolError(error, 'Failed to uninstall the plugin.');
        }
    }
}
function toPluginSummary(plugin) {
    return {
        name: plugin.name,
        ...(plugin.displayName ? { display_name: plugin.displayName } : {}),
        ...(plugin.version ? { version: plugin.version } : {}),
        ...(plugin.description ? { description: plugin.description } : {}),
        enabled: plugin.enabled === true,
        ...(plugin.marketplace ? { source: plugin.marketplace } : {}),
    };
}
//# sourceMappingURL=app-tools-service.js.map