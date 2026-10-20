import { buildPluginId, parsePluginMentions } from '@mavis/shared/plugin-mention';
import { attachPluginCapabilityAttribution, normalizedPluginSkillAttributionKey, selectPreferredAppPluginOwners, } from '@mavis/agent-core/event-bridge';
import { authorizeMcpInvokeReference, createMcpInvokeTool, revokeMcpInvokeReferenceAuthorization, resolveMcpInvokeTarget, } from '@mavis/agent-tools';
import { buildPluginReferenceReminder, detectPluginReferencesForMessages, } from '@mavis/system-reminder';
import { InstalledPluginSource, PluginCapabilityType, } from '@mavis/protocol';
import { withHostSkillContracts } from './host-capability/skill-disclosure.js';
/** Concrete mcp gateway adapter kept at the AgentHost assembly boundary. */
export function resolveDelegatedToolTarget(tool, input) {
    return resolveMcpInvokeTarget(tool, input);
}
/** One-shot Host admission for a delegated Host Binding call. */
export function authorizeDelegatedToolReference(tool, input) {
    return authorizeMcpInvokeReference(tool, input);
}
/** Removes a Host admission that cannot cross the final delivery seam. */
export function revokeDelegatedToolReferenceAuthorization(tool, input) {
    revokeMcpInvokeReferenceAuthorization(tool, input);
}
/** Resolves explicit references to trusted official or builtin host capabilities. */
export function detectReferencedOfficialHostCapabilityPlugins(input) {
    const candidates = input.capabilities?.plugins
        .filter((plugin) => (plugin.source === 'official' || plugin.source === 'builtin') &&
        plugin.hostCapabilities?.includes(input.capability) === true)
        .map((plugin) => ({
        name: plugin.name,
        pluginId: buildPluginId(plugin.name, plugin.source),
        appTools: [],
        mcpTools: [],
        skills: [],
    })) ?? [];
    if (candidates.length === 0)
        return [];
    const messages = [input.userInput, ...(input.userInput.queuedMessages ?? [])].map((message) => ({
        content: message.text,
    }));
    return detectPluginReferencesForMessages(messages, input.userInput.text, candidates).map((plugin) => plugin.name);
}
/** Applies the v1 final-catalog precedence and explicit @Plugin reminder semantics in v2. */
export function mergeAgentHostTurnCapabilities(input) {
    const merged = mergeTools(input);
    const capabilities = input.capabilities;
    if (!capabilities) {
        const reminder = buildPluginReferenceReminder([], parsePluginMentions(input.userText ?? '').map((mention) => mention.pluginId));
        return { ...merged, ...(reminder ? { reminder } : {}) };
    }
    const attributed = {
        ...merged,
        tools: attachPluginCapabilityAttribution(merged.tools, buildAttributionIndex({
            capabilities,
            effectivePluginSkills: input.effectivePluginSkills,
            finalTools: merged.tools,
            plan: merged.plan,
        })),
    };
    if (input.userText === undefined)
        return attributed;
    const inventory = buildCapabilityInventory({
        capabilities,
        effectivePluginSkills: input.effectivePluginSkills,
        // Attribution decorates relevant tools with cloned wrapper objects.
        // Inventory filtering must retain the pre-decoration identities used by Runtime bindings.
        finalTools: merged.tools,
        deferredToolNames: new Set(attributed.plan.deferred ? attributed.plan.deferredRegistry.keys() : []),
    });
    const delegable = delegablePluginIds(capabilities.agents, merged.tools);
    const unavailable = [
        ...new Set(parsePluginMentions(input.userText).map((mention) => mention.pluginId)),
    ].filter((id) => !delegable.has(id) &&
        !inventory.some((plugin) => plugin.pluginId === id &&
            (plugin.skills.length > 0 ||
                plugin.appCliProviders?.length ||
                plugin.appTools.length > 0 ||
                plugin.mcpTools.length > 0 ||
                plugin.hostTools?.some((group) => group.tools.length > 0))));
    const reminder = [
        buildPluginReferenceReminder(detectPluginReferencesForMessages([{ content: input.userText }], input.userText, inventory), unavailable),
        renderPluginAgentRoster(capabilities.agents, merged.tools),
    ]
        .filter(Boolean)
        .join('\n\n');
    return { ...attributed, ...(reminder ? { reminder } : {}) };
}
/** Plugin Agents come only from LOCAL packages and are callable only through `task`. */
function delegablePluginIds(agents, tools) {
    if (!agents?.length || !tools.some((tool) => tool.def.name === 'task'))
        return new Set();
    return new Set(agents.map((agent) => buildPluginId(agent.pluginName, 'local')));
}
const PLUGIN_AGENT_DESCRIPTION_LIMIT = 200;
/**
 * @internal Exported only for focused roster tests.
 * Stable Plugin Agent roster; emitted only when this Turn can call `task`.
 */
export function renderPluginAgentRoster(agents, tools) {
    if (!agents?.length || !tools.some((tool) => tool.def.name === 'task'))
        return undefined;
    const lines = [...agents]
        .sort((left, right) => (left.scopedName < right.scopedName ? -1 : 1))
        .map((agent) => `- \`${agent.scopedName}\`: ${rosterDescription(agent.description)}`);
    return [
        '<plugin-agents>',
        'Enabled Plugin subagents. To delegate, call `task` with `agent_name` set to the scoped name.',
        ...lines,
        '</plugin-agents>',
    ].join('\n');
}
function rosterDescription(description) {
    const flat = description.replace(/\s+/gu, ' ').trim();
    const clipped = flat.length > PLUGIN_AGENT_DESCRIPTION_LIMIT
        ? `${flat.slice(0, PLUGIN_AGENT_DESCRIPTION_LIMIT - 1)}…`
        : flat;
    return clipped.replace(/[<>&]/gu, (char) => ROSTER_ESCAPES[char] ?? char);
}
const ROSTER_ESCAPES = { '<': '&lt;', '>': '&gt;', '&': '&amp;' };
function buildAttributionIndex(input) {
    const plugins = new Map(input.capabilities.plugins.map((plugin) => [normalizedName(plugin.name), plugin]));
    const finalTools = new Set(input.finalTools);
    const directTools = new Map();
    const deferredTools = new Map();
    for (const binding of input.capabilities.runtimeToolBindings) {
        const toolName = binding.tool.def.name;
        const owners = bindingOwners(binding, plugins, input.capabilities.plugins);
        if (owners.length === 0)
            continue;
        const capabilityType = binding.kind === 'mcp' ? PluginCapabilityType.MCP : PluginCapabilityType.APP;
        const values = owners.map((plugin) => provenance(plugin, capabilityType, toolName));
        if (finalTools.has(binding.tool))
            appendProvenances(directTools, toolName, values);
        if (input.plan.deferred && input.plan.deferredRegistry.get(toolName) === binding.tool) {
            appendProvenances(deferredTools, toolName, values);
        }
    }
    const skills = new Map();
    for (const skill of input.effectivePluginSkills) {
        const plugin = plugins.get(normalizedName(skill.pluginName));
        if (!plugin)
            continue;
        appendProvenances(skills, normalizedPluginSkillAttributionKey(skill.name), [
            provenance(plugin, PluginCapabilityType.SKILL, skill.name),
        ]);
    }
    const appProviders = new Map();
    for (const provider of new Set(input.capabilities.plugins.flatMap((plugin) => plugin.appProviders))) {
        const owners = selectPreferredAppPluginOwners(provider, input.capabilities.plugins.filter((plugin) => plugin.appProviders.includes(provider)));
        appProviders.set(provider, owners.map((plugin) => provenance(plugin, PluginCapabilityType.APP, provider)));
    }
    return { directTools, deferredTools, skills, appProviders };
}
function bindingOwners(binding, plugins, allPlugins) {
    if (binding.kind === 'mcp') {
        if (!binding.pluginName)
            return [];
        const plugin = plugins.get(normalizedName(binding.pluginName));
        return plugin ? [plugin] : [];
    }
    return selectPreferredAppPluginOwners(binding.source, allPlugins.filter((plugin) => plugin.appProviders.includes(binding.source)));
}
function provenance(plugin, capabilityType, capabilityName) {
    return {
        plugin_name: plugin.name,
        ...(plugin.version ? { plugin_version: plugin.version } : {}),
        source: plugin.source === 'local' ? InstalledPluginSource.LOCAL : InstalledPluginSource.OFFICIAL,
        capability_type: capabilityType,
        capability_name: capabilityName,
        ...(plugin.iconUrl ? { icon_url: plugin.iconUrl } : {}),
        ...(plugin.darkIconUrl ? { dark_icon_url: plugin.darkIconUrl } : {}),
    };
}
function appendProvenances(target, key, values) {
    target.set(key, [...(target.get(key) ?? []), ...values]);
}
function mergeTools(input) {
    const capabilities = input.capabilities;
    const preparedHost = input.hostCapabilityRegistry?.prepare({
        tools: input.tools,
        bindings: capabilities?.hostBindings ?? [],
        surface: input.surface ?? 'interactive',
        availableSkillRuntimeNames: new Set(input.effectivePluginSkills.map((skill) => skill.name)),
    });
    const hostReferences = preparedHost?.referenceRegistry ?? new Map();
    const hostTools = preparedHost?.publicTools ?? input.tools;
    const tools = withHostSkillContracts(replaceMcpInvoke(hostTools, input.plan, hostReferences), hostReferences);
    if (!capabilities)
        return { tools, plan: input.plan };
    const bindingByTool = new Map(capabilities.runtimeToolBindings.map((binding) => [binding.tool, binding]));
    const usedNames = new Set(tools.map((tool) => toolNameKey(tool.def.name)));
    if (input.plan.deferred) {
        for (const name of input.plan.deferredRegistry.keys())
            usedNames.add(toolNameKey(name));
    }
    const selected = capabilities.runtimeTools.filter((tool) => {
        // Use source identity, not a name prefix: a Plugin MCP may use the same name.
        if (bindingByTool.get(tool)?.kind === 'app')
            return false;
        const name = toolNameKey(tool.def.name);
        if (!name || usedNames.has(name))
            return false;
        usedNames.add(name);
        return true;
    });
    return { tools: [...tools, ...selected], plan: input.plan };
}
function replaceMcpInvoke(tools, plan, hostReferences) {
    const invoke = createMcpInvokeTool(plan.deferred ? plan.deferredRegistry : new Map(), hostReferences);
    const hasInvoke = tools.some((tool) => tool.def.name === 'mcp_invoke');
    if (!hasInvoke && hostReferences.size === 0)
        return tools;
    let replaced = false;
    const result = tools.map((tool) => {
        if (tool.def.name !== 'mcp_invoke')
            return tool;
        replaced = true;
        return invoke;
    });
    return replaced ? result : [...result, invoke];
}
function buildCapabilityInventory(input) {
    const finalTools = new Set(input.finalTools);
    const searchableToolsAvailable = input.finalTools.some((tool) => tool.def.name === 'tool_search') &&
        input.finalTools.some((tool) => tool.def.name === 'mcp_invoke');
    return input.capabilities.plugins.map((plugin) => ({
        name: plugin.name,
        pluginId: buildPluginId(plugin.name, plugin.source),
        ...((plugin.source === 'official' || plugin.source === 'builtin') &&
            plugin.hostCapabilities?.includes('computer-use')
            ? {
                hostTools: [
                    {
                        source: 'computer-use',
                        tools: input.finalTools
                            .filter((tool) => tool.def.name.startsWith('computer_'))
                            .map((tool) => tool.def.name),
                    },
                ],
            }
            : {}),
        appTools: [],
        appCliProviders: plugin.appProviders,
        mcpTools: [
            ...groupMcpTools(input.capabilities.runtimeToolBindings.filter((binding) => binding.kind === 'mcp' &&
                binding.pluginName === plugin.name &&
                finalTools.has(binding.tool))),
            ...(searchableToolsAvailable
                ? groupMcpTools(input.capabilities.runtimeToolBindings.filter((binding) => binding.kind === 'mcp' &&
                    binding.pluginName === plugin.name &&
                    !finalTools.has(binding.tool) &&
                    input.deferredToolNames.has(binding.tool.def.name))).map((group) => ({ ...group, access: 'tool_search' }))
                : []),
        ],
        skills: input.effectivePluginSkills.flatMap((skill) => skill.pluginName === plugin.name ? [skill.name] : []),
    }));
}
function groupMcpTools(bindings) {
    const grouped = bindings.reduce((result, binding) => {
        const tools = result.get(binding.source) ?? [];
        tools.push(binding.tool.def.name);
        result.set(binding.source, tools);
        return result;
    }, new Map());
    return [...grouped].map(([source, tools]) => ({ source, tools }));
}
/** MCP names are case-sensitive; retain existing precedence for other tools. */
function toolNameKey(name) {
    return name.startsWith('mcp__') ? name : normalizedName(name);
}
function normalizedName(name) {
    return name.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
//# sourceMappingURL=local-turn-plugin-capabilities.js.map