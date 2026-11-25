import { normalizedPluginName } from '../../../plugin-system-helpers.js';
import { postInstallWire } from './package-views.js';
/**
 * `postInstall` comes from the installed package manifest, so only a package already on this
 * device declares it. It is a convenience: a read failure never fails the caller.
 */
export async function installedOfficialPostInstall(system, pluginName) {
    try {
        const key = normalizedPluginName(pluginName);
        const states = await system.listOfficialPluginStates();
        const plugin = states.find((state) => state.installation.installed && normalizedPluginName(state.installation.name) === key)?.plugin;
        return plugin?.postInstall ? postInstallWire(plugin.postInstall) : undefined;
    }
    catch {
        return undefined;
    }
}
/** Only a completed install answers the user's click, so only it carries the action. */
export async function withInstallPostInstall(system, action, pluginName, response) {
    if (action !== 'install' || !response.installExists)
        return response;
    const postInstall = await installedOfficialPostInstall(system, pluginName);
    return postInstall ? { ...response, postInstall } : response;
}
//# sourceMappingURL=post-install.js.map