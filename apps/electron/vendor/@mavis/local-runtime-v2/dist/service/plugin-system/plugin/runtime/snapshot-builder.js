import path from 'node:path';
import { McpNameRegistry, configuredMcpNameKey, pluginMcpNameKey } from '@mavis/mcp';
import { buildPluginSkillRuntimeName, LOCAL_PLUGIN_MARKETPLACE, OFFICIAL_PLUGIN_MARKETPLACE, pluginIdKey, samePluginId, } from '@mavis/shared';
import { hostWithholdsMiniApp } from '../package/miniapp/engines.js';
import { hasSupportedCapability } from '../package/package-readers.js';
export class PluginSnapshotBuilder {
    names;
    options;
    constructor(names = new McpNameRegistry(), options = {}) {
        this.names = names;
        this.options = options;
    }
    /** The version the engines gate compares against; undefined means the gate is off. */
    get miniAppHostVersion() {
        return this.options.hostVersion;
    }
    build(input) {
        const state = createSnapshotBuildState(input.reservations);
        appendOfficialPackages(input.officialPackages, state, this.options);
        appendLocalPackages(input, state, this.options);
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
                marketplace: plugin.id.marketplace,
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
            agents: freeze([...state.agents].sort((left, right) => left.scopedName.localeCompare(right.scopedName))),
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
        agents: [],
        pluginNames: new Set(),
        skillNames: new Set(reservations.skillNames.map(normalizedSkillKey)),
        nameOwners: new Map(),
    };
}
/** True when the Host is a parsable release older than the package's `engines.mcode`. */
export function withholdsMiniAppForHost(plugin, hostVersion) {
    return hostWithholdsMiniApp(hostVersion, plugin.miniapp?.engines?.mcode);
}
/**
 * Withholds the Mini App and the MCP servers it would have served when the Host is too old.
 * The package stays installed and listed; the diagnostic is the only trace.
 */
function gateMiniAppEngines(plugin, options, diagnostics) {
    if (!withholdsMiniAppForHost(plugin, options.hostVersion))
        return plugin;
    diagnostics.push(freeze({ code: 'MINIAPP_HOST_TOO_OLD', pluginName: plugin.name }));
    const managed = new Set(plugin.miniapp?.mcpEndpoints.map(({ server }) => server));
    const { miniapp, ...rest } = plugin;
    void miniapp;
    return { ...rest, mcpServers: rest.mcpServers.filter(({ name }) => !managed.has(name)) };
}
function appendOfficialPackages(packages, state, options) {
    const sorted = [...packages].sort((left, right) => collisionKey(left.plugin.name).localeCompare(collisionKey(right.plugin.name)) ||
        left.contentDigest.localeCompare(right.contentDigest));
    for (const entry of sorted) {
        const plugin = gateMiniAppEngines(entry.plugin, options, state.diagnostics);
        const accepted = acceptPackageCapabilities({
            plugin,
            packageContentDigest: entry.contentDigest,
            sourceKind: 'official',
            ...capabilityCollisionState(state),
        });
        if (!accepted)
            continue;
        const id = { name: plugin.name, marketplace: OFFICIAL_PLUGIN_MARKETPLACE };
        state.nameOwners.set(collisionKey(plugin.name), id);
        state.officialPackages.push(freeze({
            name: plugin.name,
            ...(plugin.version ? { version: plugin.version } : {}),
            rootPath: plugin.rootPath,
            contentDigest: entry.contentDigest,
            ...(plugin.miniapp ? { plugin } : {}),
        }));
        state.enabledPlugins.push(enabledProjection(plugin, id));
        appendRuntimeCapabilities(plugin, accepted, state);
        state.agents.push(...accepted.agents);
    }
}
/**
 * Identity and runtime name are separate: every installed PluginId stays in the
 * local projection, while at most one enabled Plugin per manifest name is
 * effective. Official packages claim names first; local Plugins claim in
 * PluginId order. A disabled or unavailable Plugin never claims a name.
 */
function appendLocalPackages(input, state, options) {
    const candidates = localCandidates(input, state);
    for (const candidate of candidates) {
        if (!candidate.enabled || candidate.entry.unavailableReason)
            continue;
        const key = collisionKey(candidate.entry.plugin.name);
        if (!state.nameOwners.has(key))
            state.nameOwners.set(key, candidate.id);
    }
    for (const candidate of candidates)
        appendLocalPlugin(candidate, state, options);
}
function localCandidates(input, state) {
    const ordered = [...input.localPackages]
        .map((entry) => ({
        entry,
        id: entry.id ?? { name: entry.plugin.name, marketplace: LOCAL_PLUGIN_MARKETPLACE },
    }))
        .sort((left, right) => compareText(pluginIdKey(left.id), pluginIdKey(right.id)) ||
        normalizedPath(left.entry.plugin.rootPath).localeCompare(normalizedPath(right.entry.plugin.rootPath)));
    const seenIds = new Set();
    const candidates = [];
    for (const { entry, id } of ordered) {
        const { plugin } = entry;
        if (seenIds.has(pluginIdKey(id))) {
            // Two roots with one identity: the first in path order is the installed copy.
            state.diagnostics.push(freeze({ code: 'LOCAL_PLUGIN_ID_CONFLICT', pluginName: plugin.name }));
            continue;
        }
        seenIds.add(pluginIdKey(id));
        if (entry.unavailableReason)
            pushReaderDiagnostics(plugin, state.diagnostics);
        else if (!acceptLocalPackage(plugin, state.diagnostics))
            continue;
        candidates.push({
            entry,
            id,
            ownership: entry.ownership ?? 'owned',
            enabled: input.isLocalEnabled(plugin.rootPath),
        });
    }
    return candidates;
}
function acceptLocalPackage(plugin, diagnostics) {
    pushReaderDiagnostics(plugin, diagnostics);
    if (!isDetailPathSegment(plugin.name)) {
        diagnostics.push(freeze({ code: 'PLUGIN_NAME_INVALID', pluginName: plugin.name }));
        return false;
    }
    if (!hasSupportedCapability(plugin)) {
        diagnostics.push(freeze({ code: 'LOCAL_PLUGIN_NO_SUPPORTED_CAPABILITY', pluginName: plugin.name }));
        return false;
    }
    return true;
}
function appendLocalPlugin(candidate, state, options) {
    const { entry, id } = candidate;
    // A package whose only capability is a withheld Mini App stays visible and uninstallable:
    // `localCandidates` admits it on the authored package, and only the served one is gated.
    const plugin = gateMiniAppEngines(entry.plugin, options, state.diagnostics);
    const owner = state.nameOwners.get(collisionKey(plugin.name));
    const effective = owner !== undefined && samePluginId(owner, id);
    state.localPlugins.push(localProjection(candidate, plugin, effective ? undefined : owner));
    if (!effective) {
        if (candidate.enabled && !entry.unavailableReason) {
            state.diagnostics.push(freeze({ code: 'LOCAL_PLUGIN_NAME_CONFLICT', pluginName: plugin.name }));
        }
        return;
    }
    state.pluginNames.add(collisionKey(plugin.name));
    const accepted = acceptRuntimeCapabilities({
        plugin,
        packageContentDigest: entry.contentDigest,
        sourceKind: 'local',
        pluginId: id,
        skillNames: state.skillNames,
        diagnostics: state.diagnostics,
    });
    state.enabledPlugins.push(enabledProjection(plugin, id));
    appendRuntimeCapabilities(plugin, accepted, state);
    state.agents.push(...accepted.agents);
}
function appendRuntimeCapabilities(plugin, accepted, state) {
    state.skills.push(...accepted.skills);
    for (const skill of accepted.skills)
        state.skillOwners.set(skill, plugin.name);
    state.mcpServers.push(...accepted.mcpServers);
    state.hooks.push(...accepted.hooks);
    state.hostBindings.push(...accepted.hostBindings);
}
/** The local Plugin whose capabilities the snapshot loads for its manifest name. */
export function isEffectiveLocalPlugin(plugin) {
    return plugin.enabled && plugin.nameOwner === undefined && plugin.unavailableReason === undefined;
}
function localProjection(candidate, plugin, nameOwner) {
    const { plugin: authoredPlugin, contentDigest, unavailableReason } = candidate.entry;
    return freeze({
        id: freeze({ ...candidate.id }),
        ownership: candidate.ownership,
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
        enabled: candidate.enabled,
        ...(nameOwner ? { nameOwner: freeze({ ...nameOwner }) } : {}),
        ...(unavailableReason ? { unavailableReason } : {}),
        plugin,
        ...(authoredPlugin === plugin ? {} : { authoredPlugin }),
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
    pushReaderDiagnostics(input.plugin, input.diagnostics);
    if (!acceptPluginName(input))
        return undefined;
    input.pluginNames.add(collisionKey(input.plugin.name));
    return acceptRuntimeCapabilities(input);
}
function pushReaderDiagnostics(plugin, diagnostics) {
    for (const diagnostic of plugin.diagnostics) {
        diagnostics.push(freeze({
            code: diagnostic.code,
            pluginName: plugin.name,
            ...(diagnostic.name ? { capabilityName: diagnostic.name } : {}),
        }));
    }
}
function acceptRuntimeCapabilities(input) {
    const skills = acceptPackageSkills(input);
    return {
        skills,
        mcpServers: acceptPackageServers(input),
        hooks: [...(input.plugin.hooks ?? [])],
        hostBindings: acceptHostBindings(input, skills),
        agents: (input.plugin.agents ?? []).map((agent) => turnPluginAgent(input, agent)),
    };
}
function turnPluginAgent(input, agent) {
    const { plugin, pluginId } = input;
    return freeze({
        scopedName: agent.scopedName,
        pluginName: plugin.name,
        ...(pluginId ? { pluginMarketplace: pluginId.marketplace } : {}),
        agentName: agent.name,
        sourceFormat: agent.sourceFormat === 'MINIMAX' ? 'minimax' : '\u0063\u006c\u0061\u0075\u0064\u0065',
        origin: input.sourceKind,
        packageDigest: input.packageContentDigest,
        pluginRoot: plugin.rootPath,
        description: agent.description,
        ...(agent.displayName ? { displayName: agent.displayName } : {}),
        systemPrompt: agent.systemPrompt,
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.effort ? { effort: agent.effort } : {}),
        ...(agent.contextWindow === undefined ? {} : { contextWindow: agent.contextWindow }),
        ...(agent.maxOutputTokens === undefined ? {} : { maxOutputTokens: agent.maxOutputTokens }),
        ...turnPluginAgentSelectors(agent),
        declaredMcpServers: freeze(plugin.mcpServers.map((server) => server.name)),
    });
}
function turnPluginAgentSelectors(agent) {
    return {
        ...(agent.tools === undefined ? {} : { tools: agent.tools }),
        ...(agent.disallowedTools === undefined ? {} : { disallowedTools: agent.disallowedTools }),
        ...(agent.mcpServers === undefined ? {} : { mcpServers: agent.mcpServers }),
        ...(agent.skills === undefined ? {} : { skills: agent.skills }),
        ...(agent.extensionSkills === undefined ? {} : { extensionSkills: agent.extensionSkills }),
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
    const pluginId = input.sourceKind === 'official'
        ? { name: input.plugin.name, marketplace: OFFICIAL_PLUGIN_MARKETPLACE }
        : (input.pluginId ?? { name: input.plugin.name, marketplace: LOCAL_PLUGIN_MARKETPLACE });
    return input.plugin.mcpServers.map((server) => freeze({
        pluginName: input.plugin.name,
        pluginId: freeze({ ...pluginId }),
        ...(input.plugin.displayName ? { pluginDisplayName: input.plugin.displayName } : {}),
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
function enabledProjection(plugin, id) {
    return freeze({
        id: freeze({ ...id }),
        name: plugin.name,
        ...(plugin.displayName ? { displayName: plugin.displayName } : {}),
        ...(plugin.version ? { version: plugin.version } : {}),
        ...(plugin.iconPath ? { iconPath: plugin.iconPath } : {}),
        ...(plugin.darkIconPath ? { darkIconPath: plugin.darkIconPath } : {}),
        source: plugin.source,
        hostCapabilities: plugin.source === 'OFFICIAL' ? freeze([...(plugin.hostCapabilities ?? [])]) : freeze([]),
        appProviders: freeze([...new Set(plugin.apps.map((app) => app.provider))]),
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
/** Code-unit order: deterministic across locales, like Codex's PluginId sort. */
function compareText(left, right) {
    if (left === right)
        return 0;
    return left < right ? -1 : 1;
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