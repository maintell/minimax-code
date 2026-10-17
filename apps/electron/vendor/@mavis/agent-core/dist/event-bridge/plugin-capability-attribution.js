import { parseAppCliToolName } from './app-cli-command.js';
/**
 * Build the host-independent resolver over a turn-local immutable attribution
 * index. Hosts own the index; this resolves direct tools and supported access tools.
 */
export function createPluginCapabilityAttributionResolver(index) {
    return (input) => resolvePluginCapabilityAttribution(index, input);
}
/** Attach one immutable attribution index to only the tools it can resolve. */
export function attachPluginCapabilityAttribution(tools, index) {
    const resolver = createPluginCapabilityAttributionResolver(index);
    return tools.map((tool) => {
        const name = tool.def.name;
        const relevant = index.directTools.has(name) ||
            (name === 'mcp_invoke' && index.deferredTools.size > 0) ||
            (name === 'skill' && index.skills.size > 0) ||
            (name === 'bash' && (index.appProviders?.size ?? 0) > 0);
        return relevant ? { ...tool, toolCallProvenanceResolver: resolver } : tool;
    });
}
function resolvePluginCapabilityAttribution(index, input) {
    if (input.toolName === 'tool_search')
        return undefined;
    if (input.toolName === 'bash') {
        const toolName = parseAppCliToolName(input.args?.command);
        if (!toolName)
            return undefined;
        // The provider must belong to this turn's Plugin snapshot. No remote discovery.
        const matches = [...(index.appProviders ?? [])].filter(([provider]) => {
            const prefix = `connector__${provider}__`;
            const suffix = toolName.slice(prefix.length);
            return toolName.startsWith(prefix) && /^[A-Za-z0-9_.-]{1,96}$/.test(suffix);
        });
        if (matches.length !== 1)
            return undefined;
        return matches[0]?.[1].map((owner) => ({
            ...owner,
            capability_name: toolName,
        }));
    }
    if (input.toolName === 'mcp_invoke') {
        const target = optionalString(input.args?.tool_name);
        return target ? copy(index.deferredTools.get(target)) : undefined;
    }
    if (input.toolName === 'skill') {
        if (input.phase !== 'end' || input.isError === true || !isSuccessfulPluginSkill(input.result)) {
            return undefined;
        }
        const skillName = optionalString(input.args?.name);
        return skillName ? copy(index.skills.get(normalizedSkillName(skillName))) : undefined;
    }
    return copy(index.directTools.get(input.toolName));
}
export function normalizedPluginSkillAttributionKey(name) {
    return normalizedSkillName(name);
}
/**
 * Prefer the Plugin whose canonical name matches the App provider. A matching
 * Plugin is the App's primary brand owner; when no such owner exists, retain
 * every effective Plugin that declares the App.
 */
export function selectPreferredAppPluginOwners(provider, owners) {
    const normalizedProvider = normalizedName(provider);
    const preferred = owners.filter((plugin) => normalizedName(plugin.name) === normalizedProvider);
    return preferred.length > 0 ? preferred : owners;
}
function isSuccessfulPluginSkill(result) {
    if (!isRecord(result) || !isRecord(result.details))
        return false;
    return ((result.details.source === 'plugin' || result.details.source === 'desktop-plugin') &&
        result.details.found === true &&
        result.details.readable === true);
}
function normalizedSkillName(name) {
    return normalizedName(name);
}
function normalizedName(name) {
    return name.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
function optionalString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function copy(value) {
    return value?.length ? value.map((item) => ({ ...item })) : undefined;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=plugin-capability-attribution.js.map