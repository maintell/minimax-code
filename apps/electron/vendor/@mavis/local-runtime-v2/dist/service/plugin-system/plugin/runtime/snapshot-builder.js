import path from 'node:path';
import { McpNameRegistry, configuredMcpNameKey, pluginMcpNameKey } from '@mavis/mcp';
import { buildPluginSkillRuntimeName } from '@mavis/shared';
export class PluginSnapshotBuilder {
    names;
    constructor(names = new McpNameRegistry()) {
        this.names = names;
    }
    build(input) {
        const state = createSnapshotBuildState(input.reservations);
        appendOfficialPackages(input.officialPackages, state);
        appendLocalPackages(input, state);
        const allocated = this.names.assignServers([
            ...input.reservations.mcpServerNames.map((name) => ({
                key: configuredMcpNameKey(name),
                name,
            })),
            ...state.mcpServers.map((entry) => ({
                key: pluginMcpNameKey(entry.source, entry.pluginName, entry.server.name),
                name: entry.server.name,
            })),
        ]);
        state.mcpServers = state.mcpServers.flatMap((entry) => {
            const key = pluginMcpNameKey(entry.source, entry.pluginName, entry.server.name);
            const runtimeServerName = allocated.names.get(key);
            if (!runtimeServerName) {
                state.diagnostics.push({
                    code: 'MCP_SERVER_NAME_INVALID',
                    pluginName: entry.pluginName,
                    capabilityName: entry.server.name,
                });
                return [];
            }
            return [freeze({ ...entry, runtimeServerName })];
        });
        const frozenSkills = freeze(state.skills.map((skill) => freeze(skill)));
        const turnCapabilities = freeze({
            revision: input.revision,
            plugins: freeze(state.enabledPlugins.map((plugin) => freeze({
                name: plugin.name,
                ...(plugin.version ? { version: plugin.version } : {}),
                source: turnPluginSource(plugin.source),
                hostCapabilities: plugin.hostCapabilities,
                ...(plugin.iconPath ? { iconUrl: localIconUrl(plugin.iconPath) } : {}),
                ...(plugin.darkIconPath ? { darkIconUrl: localIconUrl(plugin.darkIconPath) } : {}),
                ...(plugin.displayName ? { displayName: plugin.displayName } : {}),
                ...(plugin.iconPath ? { iconPath: plugin.iconPath } : {}),
                appProviders: plugin.appProviders,
            }))),
            skills: freeze(frozenSkills.map((skill) => freeze({
                pluginName: state.skillOwners.get(skill) ?? '',
                name: buildPluginSkillRuntimeName(state.skillOwners.get(skill) ?? '', skill.name),
                description: skill.description,
                content: skill.content,
                location: skill.skillFilePath,
                sourceKind: 'desktop-plugin',
            }))),
            // P4B owns live Plugin MCP tool construction. P1A freezes the per-turn
            // slot now so later tools use the same snapshot as prompt and skill reads.
            runtimeTools: freeze([]),
            runtimeToolBindings: freeze([]),
            hostBindings: freeze(state.hostBindings),
            hooks: freeze([...state.hooks]),
        });
        return freeze({
            revision: input.revision,
            officialPackages: freeze(state.officialPackages),
            localPlugins: freeze(state.localPlugins),
            enabledPlugins: freeze(state.enabledPlugins),
            skills: frozenSkills,
            mcpServers: freeze(state.mcpServers),
            diagnostics: freeze(state.diagnostics),
            turnCapabilities,
        });
    }
}
export const EMPTY_PLUGIN_SNAPSHOT = new PluginSnapshotBuilder().build({
    revision: 'plugin-snapshot-0',
    officialPackages: [],
    localPackages: [],
    isLocalEnabled: () => true,
    reservations: { skillNames: [], mcpServerNames: [], toolNames: [] },
});
export function withPluginMcpRuntime(snapshot, runtimeTools, runtimeToolBindings, diagnostics) {
    return freeze({
        ...snapshot,
        diagnostics: freeze([...snapshot.diagnostics, ...diagnostics]),
        turnCapabilities: freeze({
            ...snapshot.turnCapabilities,
            runtimeTools: freeze([...runtimeTools]),
            runtimeToolBindings: freeze([...runtimeToolBindings]),
        }),
    });
}
export function withPluginSnapshotRevision(snapshot, revision) {
    return freeze({
        ...snapshot,
        revision,
        turnCapabilities: freeze({ ...snapshot.turnCapabilities, revision }),
    });
}
function createSnapshotBuildState(reservations) {
    return {
        diagnostics: [],
        officialPackages: [],
        localPlugins: [],
        enabledPlugins: [],
        skills: [],
        skillOwners: new Map(),
        mcpServers: [],
        hooks: [],
        hostBindings: [],
        pluginNames: new Set(),
        skillNames: new Set(reservations.skillNames.map(normalizedSkillKey)),
    };
}
function appendOfficialPackages(packages, state) {
    const sorted = [...packages].sort((left, right) => collisionKey(left.plugin.name).localeCompare(collisionKey(right.plugin.name)) ||
        left.contentDigest.localeCompare(right.contentDigest));
    for (const entry of sorted) {
        const accepted = acceptPackageCapabilities({
            plugin: entry.plugin,
            packageContentDigest: entry.contentDigest,
            sourceKind: 'official',
            includeRuntimeCapabilities: true,
            ...capabilityCollisionState(state),
        });
        if (!accepted)
            continue;
        state.officialPackages.push(freeze({
            name: entry.plugin.name,
            ...(entry.plugin.version ? { version: entry.plugin.version } : {}),
            rootPath: entry.plugin.rootPath,
            contentDigest: entry.contentDigest,
            ...(entry.plugin.miniapp ? { plugin: entry.plugin } : {}),
        }));
        state.enabledPlugins.push(enabledProjection(entry.plugin));
        state.skills.push(...accepted.skills);
        for (const skill of accepted.skills)
            state.skillOwners.set(skill, entry.plugin.name);
        state.mcpServers.push(...accepted.mcpServers);
        state.hooks.push(...accepted.hooks);
        state.hostBindings.push(...accepted.hostBindings);
    }
}
function appendLocalPackages(input, state) {
    const sorted = [...input.localPackages].sort((left, right) => normalizedPath(left.plugin.rootPath).localeCompare(normalizedPath(right.plugin.rootPath)));
    for (const entry of sorted)
        appendLocalPlugin(entry, input.isLocalEnabled, state);
}
function appendLocalPlugin(entry, isLocalEnabled, state) {
    const { plugin } = entry;
    const enabled = isLocalEnabled(plugin.rootPath);
    if (state.pluginNames.has(collisionKey(plugin.name))) {
        state.diagnostics.push(freeze({ code: 'LOCAL_PLUGIN_NAME_CONFLICT', pluginName: plugin.name }));
        return;
    }
    const accepted = acceptPackageCapabilities({
        plugin,
        packageContentDigest: entry.contentDigest,
        sourceKind: 'local',
        includeRuntimeCapabilities: enabled,
        ...capabilityCollisionState(state),
    });
    if (!accepted)
        return;
    if (plugin.skills.length === 0 &&
        plugin.mcpServers.length === 0 &&
        (plugin.hooks?.length ?? 0) === 0 &&
        !plugin.miniapp) {
        state.diagnostics.push(freeze({ code: 'LOCAL_PLUGIN_NO_SUPPORTED_CAPABILITY', pluginName: plugin.name }));
        return;
    }
    state.localPlugins.push(localProjection(plugin, entry.contentDigest, enabled));
    if (!enabled)
        return;
    state.enabledPlugins.push(enabledProjection(plugin));
    state.skills.push(...accepted.skills);
    for (const skill of accepted.skills)
        state.skillOwners.set(skill, plugin.name);
    state.mcpServers.push(...accepted.mcpServers);
    state.hooks.push(...accepted.hooks);
    state.hostBindings.push(...accepted.hostBindings);
}
function localProjection(plugin, contentDigest, enabled) {
    return freeze({
        name: plugin.name,
        ...(plugin.displayName ? { displayName: plugin.displayName } : {}),
        ...(plugin.version ? { version: plugin.version } : {}),
        ...(plugin.description ? { description: plugin.description } : {}),
        ...(plugin.author ? { author: plugin.author } : {}),
        ...(plugin.iconPath ? { iconPath: plugin.iconPath } : {}),
        ...(plugin.darkIconPath ? { darkIconPath: plugin.darkIconPath } : {}),
        rootPath: plugin.rootPath,
        contentDigest,
        source: plugin.source,
        enabled,
        plugin,
    });
}
function capabilityCollisionState(state) {
    return {
        pluginNames: state.pluginNames,
        skillNames: state.skillNames,
        diagnostics: state.diagnostics,
    };
}
function acceptPackageCapabilities(input) {
    const { plugin } = input;
    for (const diagnostic of plugin.diagnostics) {
        input.diagnostics.push(freeze({
            code: diagnostic.code,
            pluginName: plugin.name,
            ...(diagnostic.name ? { capabilityName: diagnostic.name } : {}),
        }));
    }
    if (!acceptPluginName(input))
        return undefined;
    const pluginKey = collisionKey(plugin.name);
    input.pluginNames.add(pluginKey);
    if (!input.includeRuntimeCapabilities) {
        return { skills: [], mcpServers: [], hooks: [], hostBindings: [] };
    }
    const skills = acceptPackageSkills(input);
    return {
        skills,
        mcpServers: acceptPackageServers(input),
        hooks: [...(plugin.hooks ?? [])],
        hostBindings: acceptHostBindings(input, skills),
    };
}
function acceptHostBindings(input, acceptedSkills) {
    const hostBindings = input.plugin.hostBindings ?? [];
    if (hostBindings.length === 0)
        return [];
    const skillNames = new Set(acceptedSkills.map((skill) => skill.name));
    return hostBindings.flatMap((binding) => {
        if (binding.requiredSkills.some((name) => !skillNames.has(name))) {
            input.diagnostics.push(freeze({
                code: 'HOST_BINDING_SKILL_UNAVAILABLE',
                pluginName: input.plugin.name,
                capabilityName: binding.bindingId,
            }));
            return [];
        }
        return [
            freeze({
                pluginName: input.plugin.name,
                packageDigest: input.packageContentDigest,
                bindingId: binding.bindingId,
                logicalToolName: binding.logicalToolName,
                hostCapability: freeze({ ...binding.hostCapability }),
                toolRef: `plugin:${input.plugin.name}:${binding.bindingId}`,
                requiredSkillRuntimeNames: freeze(binding.requiredSkills.map((name) => buildPluginSkillRuntimeName(input.plugin.name, name))),
                allowedSurfaces: freeze([...binding.allowedSurfaces]),
            }),
        ];
    });
}
function acceptPluginName(input) {
    const { plugin } = input;
    if (!isDetailPathSegment(plugin.name)) {
        input.diagnostics.push(freeze({ code: 'PLUGIN_NAME_INVALID', pluginName: plugin.name }));
        return false;
    }
    if (!input.pluginNames.has(collisionKey(plugin.name)))
        return true;
    input.diagnostics.push(freeze({
        code: conflictCode(input.sourceKind, 'PLUGIN'),
        pluginName: plugin.name,
    }));
    return false;
}
function acceptPackageSkills(input) {
    const accepted = [];
    const packageSkillKeys = new Set();
    for (const skill of input.plugin.skills) {
        const key = normalizedSkillKey(buildPluginSkillRuntimeName(input.plugin.name, skill.name));
        if (input.skillNames.has(key) || packageSkillKeys.has(key)) {
            input.diagnostics.push(freeze({
                code: conflictCode(input.sourceKind, 'SKILL'),
                pluginName: input.plugin.name,
                capabilityName: skill.name,
            }));
            continue;
        }
        packageSkillKeys.add(key);
        accepted.push(skill);
    }
    for (const key of packageSkillKeys)
        input.skillNames.add(key);
    return accepted;
}
function acceptPackageServers(input) {
    return input.plugin.mcpServers.map((server) => freeze({
        pluginName: input.plugin.name,
        source: input.plugin.source,
        packageContentDigest: input.packageContentDigest,
        server,
    }));
}
function conflictCode(sourceKind, capability) {
    return `${sourceKind === 'local' ? 'LOCAL' : 'OFFICIAL'}_${capability}_NAME_CONFLICT`;
}
function turnPluginSource(source) {
    return source === 'OFFICIAL' ? 'official' : 'local';
}
function enabledProjection(plugin) {
    return freeze({
        name: plugin.name,
        ...(plugin.displayName ? { displayName: plugin.displayName } : {}),
        ...(plugin.version ? { version: plugin.version } : {}),
        ...(plugin.iconPath ? { iconPath: plugin.iconPath } : {}),
        ...(plugin.darkIconPath ? { darkIconPath: plugin.darkIconPath } : {}),
        source: plugin.source,
        hostCapabilities: plugin.source === 'OFFICIAL' ? freeze([...(plugin.hostCapabilities ?? [])]) : freeze([]),
        appProviders: plugin.source === 'OFFICIAL'
            ? freeze([...new Set(plugin.apps.map((app) => app.provider))])
            : freeze([]),
    });
}
function localIconUrl(iconPath) {
    if (iconPath.startsWith('minimax-builtin://'))
        return iconPath;
    return `/mavis/api/file/preview?path=${encodeURIComponent(iconPath)}`;
}
function collisionKey(value) {
    return value.trim().normalize('NFKC').toLocaleLowerCase('en-US').slice(0, 128);
}
function normalizedSkillKey(value) {
    return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
function normalizedPath(value) {
    return path.normalize(value).normalize('NFC').toLocaleLowerCase('en-US');
}
function isDetailPathSegment(value) {
    const name = value.trim();
    return (name.length > 0 &&
        name.length <= 128 &&
        name !== '.' &&
        name !== '..' &&
        !name.includes('/') &&
        !name.includes('\\') &&
        !name.includes('\0'));
}
function freeze(value) {
    return Object.freeze(value);
}
//# sourceMappingURL=snapshot-builder.js.map