import { MarketplaceCategory, PluginInstallationPolicy, } from '@mavis/thrift-gen/generated/desktop-service/types';
const BUILTIN_AGENT_PLUGIN_ICON_URL = 'minimax-builtin://plugin-icons/github';
const CATEGORY_IDS = {
    Other: MarketplaceCategory.OTHER,
    Office: MarketplaceCategory.OFFICE,
    Studio: MarketplaceCategory.STUDIO,
    'Design & Sites': MarketplaceCategory.DESIGN_AND_SITES,
    Code: MarketplaceCategory.CODE,
    Business: MarketplaceCategory.BUSINESS,
    Sales: MarketplaceCategory.SALES,
    Productivity: MarketplaceCategory.PRODUCTIVITY,
    'Science & Healthcare': MarketplaceCategory.SCIENCE_AND_HEALTHCARE,
    Education: MarketplaceCategory.EDUCATION,
};
/** Wire detail of a readable package: the same view for installed and previewed Plugins. */
export function pluginPackageDetail(plugin, installExists, enabled) {
    return {
        summary: pluginPackageSummary(plugin, installExists, enabled),
        apps: plugin.apps.map(({ provider }) => ({ provider })),
        mcpServers: plugin.mcpServers.map((server) => ({
            name: server.name,
            transport: declaredTransport(server.configJson),
            ...(server.description ? { description: server.description } : {}),
            configJson: server.configJson,
        })),
        skills: plugin.skills.map((skill) => ({
            name: skill.name,
            description: skill.description,
            content: skill.content,
        })),
        exampleQueries: [...plugin.exampleQueries],
        ...(plugin.agents?.length
            ? {
                agents: plugin.agents.map((agent) => ({
                    name: agent.scopedName,
                    description: agent.description,
                    content: agent.content,
                })),
            }
            : {}),
    };
}
export function pluginPackageSummary(plugin, installExists, enabled) {
    return {
        name: plugin.name,
        ...(plugin.version ? { version: plugin.version } : {}),
        ...(plugin.displayName ? { displayName: plugin.displayName } : {}),
        ...(plugin.description ? { description: plugin.description } : {}),
        ...(plugin.author ? { author: plugin.author } : {}),
        ...optionalPluginIcon(plugin),
        capabilities: {
            appCount: plugin.apps.length,
            mcpServerCount: plugin.mcpServers.length,
            skillCount: plugin.skills.length,
            hookCount: plugin.hooks?.length ?? 0,
            agentCount: plugin.agents?.length ?? 0,
        },
        installExists,
        enabled,
        installationPolicy: PluginInstallationPolicy.USER_MANAGED,
        category: categoryId(plugin.category),
    };
}
export function declaredTransport(configJson) {
    try {
        const parsed = JSON.parse(configJson);
        if (typeof parsed.type === 'string')
            return parsed.type;
        if (typeof parsed.command === 'string')
            return 'stdio';
        if (typeof parsed.url === 'string')
            return 'http';
    }
    catch {
        // The package reader already validated this object; retain a safe label if
        // an in-memory test double supplies an invalid value.
    }
    return 'unknown';
}
function localIconUrl(iconPath) {
    if (iconPath.startsWith('minimax-builtin://'))
        return iconPath;
    return `/mavis/api/file/preview?path=${encodeURIComponent(iconPath)}`;
}
export function optionalPluginIcon(plugin) {
    if (plugin.iconPath) {
        return {
            iconUrl: localIconUrl(plugin.iconPath),
            ...(plugin.darkIconPath ? { darkIconUrl: localIconUrl(plugin.darkIconPath) } : {}),
        };
    }
    if (plugin.source === 'LOCAL_AGENT_PLUGIN') {
        return { iconUrl: BUILTIN_AGENT_PLUGIN_ICON_URL };
    }
    return {};
}
export function categoryId(value) {
    return CATEGORY_IDS[value];
}
/** Undefined for a missing or unknown wire category id. */
export function categoryName(value) {
    if (value === undefined)
        return undefined;
    return Object.keys(CATEGORY_IDS).find((name) => CATEGORY_IDS[name] === value);
}
//# sourceMappingURL=package-views.js.map