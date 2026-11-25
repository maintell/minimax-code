import { normalizedPluginName } from '../../../plugin-system/index.js';
import { ExtensionServiceError } from '../../errors.js';
/**
 * Name resolution (two.md §1.5): own package declared name → user config name → another
 * plugin's server, written `'<plugin>/<server>'` (a bare name also finds it when unique). The own
 * package always wins; a user config and another plugin answering the same name is ambiguous.
 */
export function resolveMcpServer(origin, name, targets) {
    const own = targets.filter((target) => target.owner.kind === 'plugin' &&
        samePlugin(target.owner.activation.pluginId, origin.pluginId) &&
        target.owner.activation.source === origin.source &&
        target.server === name);
    const candidates = own.length > 0
        ? own
        : [
            ...targets.filter((target) => target.owner.kind === 'configured' && target.server === name),
            ...targets.filter((target) => matchesOtherPlugin(target, origin, name)),
        ];
    const [first, ...rest] = candidates;
    if (!first) {
        throw new ExtensionServiceError('MCP_SERVER_NOT_FOUND', `no connected MCP server "${name}" in this session`, 'not_dispatched');
    }
    if (rest.length > 0) {
        throw new ExtensionServiceError('MCP_SERVER_AMBIGUOUS', `MCP server "${name}" matches ${candidates.length} servers; write '<plugin>/<server>'`, 'not_dispatched');
    }
    return first;
}
function matchesOtherPlugin(target, origin, name) {
    if (target.owner.kind !== 'plugin')
        return false;
    const plugin = target.owner.activation.pluginId;
    if (`${plugin}/${target.server}` === name)
        return true;
    return target.server === name && !samePlugin(plugin, origin.pluginId);
}
/** Plugin names compare as the plugin system's name reservation does. */
function samePlugin(left, right) {
    return normalizedPluginName(left) === normalizedPluginName(right);
}
//# sourceMappingURL=resolution.js.map