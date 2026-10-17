import { InstalledPluginSource, PluginCapabilityType, } from '@mavis/thrift-gen/generated/desktop-service/types';
import { asArray, asObject, isObject } from './desktop-session-mapper-support.js';
export function mapPluginCapabilityProvenanceViews(value) {
    const provenances = asArray(value).flatMap((item) => {
        const provenance = mapPluginCapabilityProvenanceView(item);
        return provenance ? [provenance] : [];
    });
    return provenances.length > 0 ? provenances : undefined;
}
function mapPluginCapabilityProvenanceView(value) {
    if (!isObject(value))
        return undefined;
    const obj = asObject(value);
    const pluginName = nonEmptyString(obj.pluginName ?? obj.plugin_name);
    const pluginVersion = nonEmptyString(obj.pluginVersion ?? obj.plugin_version);
    const source = mapInstalledPluginSource(obj.source);
    const capabilityType = mapPluginCapabilityType(obj.capabilityType ?? obj.capability_type);
    const capabilityName = nonEmptyString(obj.capabilityName ?? obj.capability_name);
    if (!pluginName || source === undefined || capabilityType === undefined || !capabilityName) {
        return undefined;
    }
    const iconUrl = nonEmptyString(obj.iconUrl ?? obj.icon_url);
    const darkIconUrl = nonEmptyString(obj.darkIconUrl ?? obj.dark_icon_url);
    return {
        pluginName,
        ...(pluginVersion ? { pluginVersion } : {}),
        source,
        capabilityType,
        capabilityName,
        ...(iconUrl ? { iconUrl } : {}),
        ...(darkIconUrl ? { darkIconUrl } : {}),
    };
}
function mapInstalledPluginSource(value) {
    if (value === InstalledPluginSource.OFFICIAL || value === 'OFFICIAL') {
        return InstalledPluginSource.OFFICIAL;
    }
    if (value === InstalledPluginSource.LOCAL || value === 'LOCAL') {
        return InstalledPluginSource.LOCAL;
    }
    return undefined;
}
function mapPluginCapabilityType(value) {
    if (value === PluginCapabilityType.APP || value === 'APP')
        return PluginCapabilityType.APP;
    if (value === PluginCapabilityType.MCP || value === 'MCP')
        return PluginCapabilityType.MCP;
    if (value === PluginCapabilityType.SKILL || value === 'SKILL')
        return PluginCapabilityType.SKILL;
    return undefined;
}
function nonEmptyString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
//# sourceMappingURL=desktop-plugin-provenance-mapper.js.map